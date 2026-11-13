import { Client, StageChannel, type Message, type VoiceBasedChannel } from "discord.js-selfbot-v13";
import { Streamer, Utils, prepareStream, playStream } from "@dank074/discord-video-stream";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- config ---
type Config = {
    token?: string;
    host?: string;
    port?: number;
    panelPassword?: string;
    prefix?: string;
    acceptedAuthors?: string[];
    cookiesFile?: string;
    streamOpts: {
        width: number;
        height: number;
        fps: number;
        bitrateKbps: number;
        maxBitrateKbps: number;
        hardware_acceleration: boolean;
        videoCodec: string;
    };
};

function loadConfig(): Config {
    const file = path.resolve(process.cwd(), "config.json");
    const fromFile: Partial<Config> = existsSync(file)
        ? JSON.parse(readFileSync(file, "utf8"))
        : {};
    return {
        host: "127.0.0.1",
        port: 3000,
        prefix: "L!",
        ...fromFile,
        token: process.env.DISCORD_TOKEN ?? fromFile.token,
        streamOpts: {
            width: 1280,
            height: 720,
            fps: 30,
            bitrateKbps: 2500,
            maxBitrateKbps: 4000,
            hardware_acceleration: false,
            videoCodec: "H264",
            ...fromFile.streamOpts,
        },
    };
}

const config = loadConfig();

// --------------------------------------------------------------- playback ---
type Status = "idle" | "loading" | "playing" | "paused";

type Playback = {
    controller: AbortController;
    sourceUrl: string;
    title?: string;
    durationSeconds?: number;
    positionSeconds: number;
    startedAt: number; // 0 while paused / not started
    status: Status;
    output?: ReturnType<typeof prepareStream>["output"];
    guildId: string;
    channelId: string;
    error?: string;
};

// The Discord session is created when you log in with a token (web page, DISCORD_TOKEN or config.json).
let streamer: Streamer | undefined;
let loggingIn = false;
let current: Playback | undefined;
let lastError: string | undefined;

function position(p: Playback): number {
    if (p.status !== "playing" || p.startedAt === 0) return p.positionSeconds;
    return p.positionSeconds + (Date.now() - p.startedAt) / 1000;
}

function stateSnapshot() {
    return {
        loggedIn: Boolean(streamer?.client.user),
        loggingIn,
        user: streamer?.client.user?.tag ?? null,
        prefix: config.prefix ?? "L!",
        voice: voiceInfo(),
        status: current?.status ?? "idle",
        title: current?.title ?? null,
        sourceUrl: current?.sourceUrl ?? null,
        guildId: current?.guildId ?? null,
        channelId: current?.channelId ?? null,
        position: current ? Math.floor(position(current)) : 0,
        duration: current?.durationSeconds ?? null,
        error: lastError ?? null,
    };
}

type Resolved = {
    mediaUrl: string;
    title: string;
    duration: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isYouTube(input: string): boolean {
    return /(?:youtube\.com|youtu\.be)\//i.test(input);
}

function findCookiesFile(): string | undefined {
    return [
        config.cookiesFile,
        path.resolve(process.cwd(), "cookies.txt"),
        path.resolve(process.cwd(), "src/cookies.txt"),
    ].find((file): file is string => Boolean(file) && existsSync(file));
}

/** Turn a YouTube link into a direct media URL (yt-dlp). Direct URLs pass through. */
async function resolveMedia(input: string): Promise<Resolved> {
    if (!/^https?:\/\//i.test(input)) throw new Error("Please paste a valid http(s) link.");
    if (!isYouTube(input)) return { mediaUrl: input, title: input, duration: null };
    const cookies = findCookiesFile();

    try {
        const { stdout } = await execFileAsync(
            "yt-dlp",
            [
                "--no-playlist",
                "--format",
                "best[acodec!=none][vcodec!=none]/best",
                ...(cookies ? ["--cookies", cookies] : []),
                "--dump-single-json",
                input,
            ],
            { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
        );
        const info: unknown = JSON.parse(stdout);
        if (!isRecord(info)) throw new Error("yt-dlp returned invalid video metadata");
        const requestedFormats = Array.isArray(info.requested_formats) ? info.requested_formats : [];
        const selectedFormat = requestedFormats.find(isRecord) ?? info;
        const mediaUrl = typeof info.url === "string"
            ? info.url
            : typeof selectedFormat.url === "string" ? selectedFormat.url : "";
        if (!mediaUrl) throw new Error("yt-dlp returned no media URL");
        const duration = typeof info.duration === "number" && Number.isFinite(info.duration)
            ? info.duration
            : null;
        return {
            mediaUrl,
            title: typeof info.title === "string" ? info.title : input,
            duration,
        };
    } catch (error) {
        throw new Error(
            "Unable to generate a video URL. Make sure yt-dlp is installed and the video is accessible.",
            { cause: error },
        );
    }
}

type YtDlpStream = {
    output: Readable;
    completion: Promise<void>;
    stop: () => void;
};

function streamYouTube(input: string, signal: AbortSignal): YtDlpStream {
    signal.throwIfAborted();
    const cookies = findCookiesFile();
    const child = spawn("yt-dlp", [
        "--no-playlist",
        "--format",
        "best[acodec!=none][vcodec!=none]/best",
        ...(cookies ? ["--cookies", cookies] : []),
        "--no-progress",
        "--output",
        "-",
        input,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    if (!child.stdout || !child.stderr) {
        child.kill();
        throw new Error("Unable to start yt-dlp media stream.");
    }

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-4096);
    });

    let stopped = false;
    const stop = () => {
        stopped = true;
        child.kill();
    };
    const completion = new Promise<void>((resolve, reject) => {
        child.once("error", (error) => reject(new Error(`Unable to start yt-dlp: ${errMsg(error, "process error")}`)));
        child.once("close", (code, childSignal) => {
            signal.removeEventListener("abort", stop);
            if (signal.aborted || stopped || code === 0) {
                resolve();
                return;
            }
            const details = ffmpegErrorMessage(stderr);
            reject(new Error(
                `yt-dlp failed${code === null ? ` (${childSignal ?? "unknown signal"})` : ` with exit code ${code}`}${details ? `: ${details}` : ""}`,
            ));
        });
    });
    void completion.catch(() => {});
    signal.addEventListener("abort", stop, { once: true });

    return { output: child.stdout, completion, stop };
}

function stop(): void {
    current?.controller.abort();
    current = undefined;
}

async function watch(sourceUrl: string, guildId: string, channelId: string): Promise<void> {
    const s = requireStreamer();
    const channel = s.client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
    if (!channel) throw new Error("Choose a Group and a voice channel first.");

    stop();
    lastError = undefined;
    const playback: Playback = {
        controller: new AbortController(),
        sourceUrl,
        positionSeconds: 0,
        startedAt: 0,
        status: "loading",
        guildId,
        channelId,
    };
    current = playback;

    // Run in background so the HTTP request returns immediately.
    void run(playback).catch((error: unknown) => {
        if (playback.controller.signal.aborted) return;
        console.error("Playback failed", error);
        lastError = error instanceof Error ? error.message : "Unable to play stream.";
    }).finally(() => {
        if (current === playback) current = undefined;
    });
}

async function run(playback: Playback): Promise<void> {
    const { signal } = playback.controller;
    const resolved = await resolveMedia(playback.sourceUrl);
    if (signal.aborted) return;
    playback.title = resolved.title;
    playback.durationSeconds = resolved.duration ?? undefined;

    const s = requireStreamer();
    await connectVoice(s, playback.guildId, playback.channelId, false);
    if (signal.aborted) return;

    const youtubeStream = isYouTube(playback.sourceUrl)
        ? streamYouTube(playback.sourceUrl, signal)
        : undefined;
    const o = config.streamOpts;
    let prepared: ReturnType<typeof prepareStream>;
    try {
        prepared = prepareStream(
            youtubeStream?.output ?? resolved.mediaUrl,
            {
                width: o.width,
                height: o.height,
                frameRate: o.fps,
                bitrateVideo: o.bitrateKbps,
                bitrateVideoMax: o.maxBitrateKbps,
                hardwareAcceleratedDecoding: o.hardware_acceleration,
                videoCodec: Utils.normalizeVideoCodec(o.videoCodec),
            },
            signal,
        );
    } catch (error) {
        youtubeStream?.stop();
        throw error;
    }
    const { command, output, promise } = prepared;
    playback.output = output;
    command.on("error", (error: unknown) => console.error("ffmpeg error", ffmpegErrorMessage(error)));
    void promise.catch((error: unknown) => {
        if (!signal.aborted) console.error("ffmpeg process failed", ffmpegErrorMessage(error));
    });

    playback.status = "playing";
    playback.startedAt = Date.now();
    const playbackPromise = playStream(output, s, { type: "go-live" }, signal).catch((error: unknown) => {
        youtubeStream?.stop();
        throw error;
    });
    if (youtubeStream) {
        const [playbackResult, sourceResult] = await Promise.allSettled([
            playbackPromise,
            youtubeStream.completion,
        ]);
        if (sourceResult.status === "rejected") throw sourceResult.reason;
        if (playbackResult.status === "rejected") throw playbackResult.reason;
    } else {
        await playbackPromise;
    }
}

function pause(): void {
    if (!current || current.status !== "playing") throw new Error("Nothing is playing.");
    current.positionSeconds = position(current);
    current.startedAt = 0;
    current.status = "paused";
    current.output?.pause();
}

function resume(): void {
    if (!current || current.status !== "paused") throw new Error("Nothing is paused.");
    current.startedAt = Date.now();
    current.status = "playing";
    current.output?.resume();
}

// ------------------------------------------------- account, voice, commands ---
const VOICE_STATE_UPDATE = 4;

function requireStreamer(): Streamer {
    if (!streamer?.client.user) throw new Error("Log in with a Discord token first.");
    return streamer;
}

function errMsg(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
}

function ffmpegErrorMessage(error: unknown): string {
    return errMsg(error, "FFmpeg process failed.").replace(/https?:\/\/[^\s]+/gi, "[media URL]");
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error: unknown) => { clearTimeout(timer); reject(new Error(errMsg(error, message))); },
        );
    });
}

/** Log in with a custom token (from the web page). Replaces any existing session. */
async function login(rawToken: string): Promise<void> {
    const token = rawToken.replace(/^["']|["']$/g, "").trim();
    if (!token) throw new Error("Paste a Discord token first.");
    if (loggingIn) throw new Error("Already logging in, please wait.");
    loggingIn = true;
    try {
        logout();
        lastError = undefined;
        const client = new Client();
        const next = new Streamer(client);
        client.on("messageCreate", (message) => {
            void handleCommand(next, message).catch((error: unknown) => console.error("Command failed", error));
        });
        try {
            await withTimeout(
                new Promise<void>((resolve, reject) => {
                    client.once("ready", () => resolve());
                    client.login(token).catch(reject);
                }),
                30_000,
                "Login timed out.",
            );
        } catch (error) {
            client.destroy();
            throw new Error(`Login failed: ${errMsg(error, "invalid token")}`);
        }
        streamer = next;
        console.log(`--- ${client.user?.tag} is ready ---`);
    } finally {
        loggingIn = false;
    }
}

function logout(): void {
    stop();
    const s = streamer;
    streamer = undefined;
    if (!s) return;
    try { leaveCurrentVoice(s); } catch { /* ignore */ }
    s.client.destroy();
}

function voiceInfo() {
    const vc = streamer?.voiceConnection;
    if (!streamer || !vc) return null;
    const guild = vc.guildId ? streamer.client.guilds.cache.get(vc.guildId) : undefined;
    return {
        guildId: vc.guildId,
        channelId: vc.channelId,
        guild: guild?.name ?? null,
        channel: guild?.channels.cache.get(vc.channelId)?.name ?? null,
    };
}

/** Leave the voice channel. leaveVoice() only signals guild_id: null, so also tell Discord which server. */
function leaveCurrentVoice(s: Streamer): boolean {
    const wasConnected = Boolean(s.voiceConnection);
    s.leaveVoice();
    const inVoice = [...s.client.guilds.cache.values()].filter((g) => g.members.me?.voice.channelId);
    for (const g of inVoice) {
        s.sendOpcode(VOICE_STATE_UPDATE, {
            guild_id: g.id,
            channel_id: null,
            self_mute: true,
            self_deaf: false,
            self_video: false,
        });
    }
    return wasConnected || inVoice.length > 0;
}

/** Join a voice channel (leaving the current one first if it is a different channel). */
async function connectVoice(s: Streamer, guildId: string, channelId: string, interrupt = true): Promise<string> {
    const channel = s.client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
    if (!channel || (channel.type !== "GUILD_VOICE" && channel.type !== "GUILD_STAGE_VOICE")) {
        throw new Error("Choose a Group and a voice channel first.");
    }
    const vc = s.voiceConnection;
    if (!vc || vc.guildId !== guildId || vc.channelId !== channelId) {
        if (interrupt) stop();
        if (vc) leaveCurrentVoice(s);
        try {
            await withTimeout(
                s.joinVoice(guildId, channelId),
                20_000,
                "Timed out joining the voice channel. Check that the account can connect to it.",
            );
        } catch (error) {
            leaveCurrentVoice(s);
            throw new Error(errMsg(error, "Unable to join the voice channel."));
        }
    }
    if (channel instanceof StageChannel) await s.client.user?.voice?.setSuppressed(false);
    return channel.name;
}

function leaveVoiceChannel(): boolean {
    const s = requireStreamer();
    stop();
    return leaveCurrentVoice(s);
}

/** Discord chat commands: L!join [channelId] and L!leave (your own account + config.acceptedAuthors). */
async function handleCommand(s: Streamer, message: Message): Promise<void> {
    if (message.author.bot || !message.content) return;
    const prefix = config.prefix ?? "L!";
    const content = message.content.trim();
    if (!content.toLowerCase().startsWith(prefix.toLowerCase())) return;
    const [rawCommand, ...args] = content.slice(prefix.length).trim().split(/\s+/);
    const command = rawCommand?.toLowerCase();
    if (command !== "join" && command !== "leave") return;

    const allowed =
        message.author.id === s.client.user?.id || (config.acceptedAuthors ?? []).includes(message.author.id);
    if (!allowed) return;

    try {
        if (command === "leave") {
            await message.reply(leaveVoiceChannel() ? "Left the voice channel." : "I'm not in a voice channel.");
            return;
        }

        let channel: VoiceBasedChannel | null | undefined;
        if (args[0]) {
            const found = s.client.channels.cache.get(args[0]);
            channel =
                found && (found.type === "GUILD_VOICE" || found.type === "GUILD_STAGE_VOICE")
                    ? (found as VoiceBasedChannel)
                    : null;
            if (!channel) {
                await message.reply("I can't find that voice channel.");
                return;
            }
        } else {
            const own = message.member?.voice.channel ?? message.author.voice?.channel;
            channel = own && (own.type === "GUILD_VOICE" || own.type === "GUILD_STAGE_VOICE") ? own : null;
            if (!channel) {
                await message.reply(`Join a voice channel first, or use ${prefix}join <channelId>.`);
                return;
            }
        }
        const name = await connectVoice(s, channel.guildId, channel.id);
        await message.reply(`Joined ${name}.`);
    } catch (error) {
        await message.reply(errMsg(error, "The command failed.")).catch(() => undefined);
    }
}

// ------------------------------------------------------------------- http ---
function listGuilds() {
    return [...(streamer?.client.guilds.cache.values() ?? [])]
        .map((g) => ({
            id: g.id,
            name: g.name,
            channels: [...g.channels.cache.values()]
                .filter((c) => c.type === "GUILD_VOICE" || c.type === "GUILD_STAGE_VOICE")
                .map((c) => ({
                    id: c.id,
                    name: c.name,
                    stage: c.type === "GUILD_STAGE_VOICE",
                    position: "position" in c ? Number(c.position) : 0,
                }))
                .sort((a, b) => a.position - b.position),
        }))
        .filter((g) => g.channels.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 64 * 1024) throw new Error("Request too large");
        chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? "/", "http://localhost");

        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
            const file = [
                path.join(__dirname, "public/index.html"),
                path.resolve(process.cwd(), "src/public/index.html"),
            ].find(existsSync);
            if (!file) return send(res, 500, { error: "index.html not found" });
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            return void res.end(readFileSync(file));
        }

        if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });

        if (config.panelPassword && req.headers["x-panel-password"] !== config.panelPassword) {
            return send(res, 401, { error: "Wrong or missing panel password" });
        }

        if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, stateSnapshot());
        if (req.method === "GET" && url.pathname === "/api/guilds") return send(res, 200, listGuilds());

        if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
        const body = await readJson(req);

        switch (url.pathname) {
            case "/api/login":
                await login(str(body.token));
                return send(res, 200, stateSnapshot());
            case "/api/logout":
                logout();
                return send(res, 200, stateSnapshot());
            case "/api/join": {
                const joined = await connectVoice(requireStreamer(), str(body.guildId), str(body.channelId));
                return send(res, 200, { ...stateSnapshot(), joined });
            }
            case "/api/leave":
                leaveVoiceChannel();
                return send(res, 200, stateSnapshot());
            case "/api/generate": {
                const resolved = await resolveMedia(str(body.url));
                return send(res, 200, resolved);
            }
            case "/api/watch": {
                const link = str(body.url);
                if (!link) return send(res, 400, { error: "Paste a YouTube link first." });
                await watch(link, str(body.guildId), str(body.channelId));
                return send(res, 200, stateSnapshot());
            }
            case "/api/pause":
                pause();
                return send(res, 200, stateSnapshot());
            case "/api/resume":
                resume();
                return send(res, 200, stateSnapshot());
            case "/api/stop":
                stop();
                return send(res, 200, stateSnapshot());
            default:
                return send(res, 404, { error: "Not found" });
        }
    } catch (error) {
        send(res, 400, { error: error instanceof Error ? error.message : "Request failed" });
    }
});

server.listen(config.port, config.host, () => {
    console.log(`Control panel: http://${config.host}:${config.port}`);
    if (!["127.0.0.1", "localhost", "::1"].includes(config.host ?? "") && !config.panelPassword) {
        console.warn("WARNING: the panel is reachable from the network without a panelPassword. Set one in config.json.");
    }
});

// Optional: auto-login with DISCORD_TOKEN or config.json. Otherwise paste a token on the web page.
if (config.token && !config.token.startsWith("PUT_YOUR")) {
    login(config.token).catch((error: unknown) => console.error(errMsg(error, "Auto-login failed.")));
} else {
    console.log("No token configured. Open the page and paste your Discord token to log in.");
}
