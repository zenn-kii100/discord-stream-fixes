import { Client, StageChannel, type Message, type VoiceBasedChannel } from "discord.js-selfbot-v13";
import { Streamer, Utils, prepareStream, playStream } from "@dank074/discord-video-stream";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import config from "./config.json" with { type: "json" };

const execFileAsync = promisify(execFile);
const streamer = new Streamer(new Client());

type ActivePlayback = {
    controller: AbortController;
    inputUrl: string;
    resolvedUrl?: string;
    positionSeconds: number;
    startedAt: number;
    paused: boolean;
    output?: ReturnType<typeof prepareStream>["output"];
    durationSeconds?: number;
    type: "go-live" | "camera";
};

let activePlayback: ActivePlayback | undefined;
let selectedUrl: string | undefined;
let loopEnabled = false;

streamer.client.on("ready", () => {
    console.log(`--- ${streamer.client.user?.tag} is ready ---`);
});

streamer.client.on("messageCreate", (message) => {
    void handleMessage(message).catch((error: unknown) => {
        console.error("Unable to handle command", error);
        void message.reply("The command failed. Check the bot console for details.")
            .catch((replyError: unknown) => console.error("Unable to send command error", replyError));
    });
});

streamer.client.login(config.token);

async function handleMessage(message: Message): Promise<void> {
    if (message.author.bot || !message.content) return;

    const content = message.content.trim();
    const isLegacyCommand = /^\$(?:play-live|play-cam|disconnect|stop-stream)(?:\s|$)/i.test(content);
    if (!content.startsWith(config.prefix) && !isLegacyCommand) return;

    if (!config.acceptedAuthors.includes(message.author.id)) {
        console.warn(`Ignoring command from unauthorized author ${message.author.id}`);
        await message.reply("You are not authorized to use these commands. Add your Discord user ID to acceptedAuthors in src/config.json.");
        return;
    }

    if (isLegacyCommand) {
        const [legacyCommand, url] = content.split(/\s+/);
        switch (legacyCommand.toLowerCase()) {
            case "$play-live":
            case "$play-cam":
                if (!url) {
                    await message.reply(`Usage: ${legacyCommand} <url>`);
                    return;
                }
                selectedUrl = url;
                await startPlayback(url, message, 0, false, legacyCommand === "$play-cam" ? "camera" : "go-live");
                return;
            case "$disconnect":
                leaveVoiceChannel();
                return;
            case "$stop-stream":
                stopPlayback();
                return;
        }
    }

    const commandText = content.slice(config.prefix.length).trim();
    const [command, ...args] = commandText.split(/\s+/);
    switch (command?.toLowerCase()) {
        case "help":
            await message.reply([
                "Help",
                "",
                `    ${config.prefix}p \`url\` | Youtube | direct link (without downloading)`,
                "",
                `    ${config.prefix}play | Play video`,
                "",
                `    ${config.prefix}pause | Pause video`,
                "",
                `    ${config.prefix}duration | Show video duration`,
                "",
                `    ${config.prefix}seek | Show current video time`,
                "",
                `    ${config.prefix}seek \`sec, +sec, -sec\` | Change video time`,
                "",
                `    ${config.prefix}loop | Toggle playing video on loop`,
                "",
                `    ${config.prefix}join | Join your voice channel (or ${config.prefix}join \`channelId\`)`,
                "",
                `    ${config.prefix}leave | Leave the voice channel`,
                "",
                `    ${config.prefix}stop | Stop streaming`,
            ].join("\n"));
            return;
        case "p": {
            const url = args[0];
            if (!url) {
                await message.reply(`Usage: ${config.prefix}p <YouTube URL or direct video URL>`);
                return;
            }
            selectedUrl = url;
            await startPlayback(url, message);
            return;
        }
        case "play":
            if (activePlayback?.paused) {
                activePlayback.positionSeconds = currentPosition(activePlayback);
                activePlayback.startedAt = Date.now();
                activePlayback.paused = false;
                activePlayback.output?.resume();
                await message.reply("Playback resumed.");
                return;
            }
            if (activePlayback) {
                await message.reply("A video is already playing.");
                return;
            }
            if (!selectedUrl) {
                await message.reply(`Set a video URL first with ${config.prefix}p <url>.`);
                return;
            }
            await startPlayback(selectedUrl, message);
            return;
        case "pause":
            if (!activePlayback) {
                await message.reply("There is no video playing.");
                return;
            }
            if (!activePlayback.paused) {
                activePlayback.positionSeconds = currentPosition(activePlayback);
                activePlayback.paused = true;
                activePlayback.output?.pause();
            }
            await message.reply("Playback paused. Use the play command to resume.");
            return;
        case "duration": {
            const url = activePlayback?.resolvedUrl ?? selectedUrl;
            if (!url) {
                await message.reply(`Set a video URL first with ${config.prefix}p <url>.`);
                return;
            }
            try {
                const duration = await getDuration(activePlayback?.resolvedUrl ?? await resolveMediaUrl(url));
                if (activePlayback) activePlayback.durationSeconds = duration;
                await message.reply(`Video duration: ${formatTime(duration)}.`);
            } catch (error) {
                console.error("Unable to determine video duration", error);
                await message.reply("Unable to determine the video duration. Check that ffprobe is installed and the URL is accessible.");
            }
            return;
        }
        case "seek": {
            if (!activePlayback) {
                await message.reply("There is no video playing.");
                return;
            }
            if (args.length === 0) {
                await message.reply(`Current video time: ${formatTime(currentPosition(activePlayback))}.`);
                return;
            }
            const input = args[0];
            const requested = Number(input);
            if (!Number.isFinite(requested)) {
                await message.reply(`Usage: ${config.prefix}seek <seconds, +seconds, or -seconds>.`);
                return;
            }
            const current = currentPosition(activePlayback);
            const target = input.startsWith("+") || input.startsWith("-") ? current + requested : requested;
            const duration = activePlayback.durationSeconds;
            const boundedTarget = Math.max(0, duration === undefined ? target : Math.min(target, duration));
            const { inputUrl, paused, type } = activePlayback;
            await startPlayback(inputUrl, message, boundedTarget, paused, type);
            if (activePlayback) activePlayback.durationSeconds = duration;
            return;
        }
        case "loop":
            loopEnabled = !loopEnabled;
            await message.reply(`Loop is ${loopEnabled ? "on" : "off"}.`);
            return;
        case "join": {
            const target = args[0]
                ? streamer.client.channels.cache.get(args[0])
                : (message.member?.voice.channel ?? message.author.voice?.channel);
            if (!target || (target.type !== "GUILD_VOICE" && target.type !== "GUILD_STAGE_VOICE")) {
                await message.reply(`Join a voice channel first, or use ${config.prefix}join <channelId>.`);
                return;
            }
            await joinChannel(target);
            await message.reply(`Joined ${target.name}.`);
            return;
        }
        case "leave":
            await message.reply(leaveVoiceChannel() ? "Left the voice channel." : "I'm not in a voice channel.");
            return;
        case "stop":
            if (!activePlayback) {
                await message.reply("There is no video streaming.");
                return;
            }
            stopPlayback();
            await message.reply("Streaming stopped.");
    }
}

async function startPlayback(
    inputUrl: string,
    message: Message,
    positionSeconds = 0,
    paused = false,
    type: ActivePlayback["type"] = "go-live",
    notify = true,
): Promise<void> {
    activePlayback?.controller.abort();
    const playback: ActivePlayback = {
        controller: new AbortController(),
        inputUrl,
        positionSeconds,
        startedAt: 0,
        paused,
        type,
    };
    activePlayback = playback;

    if (notify) {
        await message.reply(paused ? `Seeking to ${formatTime(positionSeconds)} (paused).` : "Starting video stream.");
    }
    void runPlayback(playback, message).catch((error: unknown) => {
        console.error("Playback task failed", error);
    });
}

async function runPlayback(playback: ActivePlayback, message: Message): Promise<void> {
    try {
        const mediaUrl = await resolveMediaUrl(playback.inputUrl);
        if (activePlayback !== playback) return;
        playback.resolvedUrl = mediaUrl;

        const channel = message.member?.voice.channel ?? message.author.voice?.channel;
        if (!channel) throw new Error("Join a voice channel before starting playback.");
        if (
            !streamer.voiceConnection ||
            streamer.voiceConnection.guildId !== message.guildId ||
            streamer.voiceConnection.channelId !== channel.id
        ) {
            await streamer.joinVoice(message.guildId, channel.id);
        }
        if (channel instanceof StageChannel) {
            await streamer.client.user?.voice?.setSuppressed(false);
        }

        const { command, output, promise } = prepareStream(
            mediaUrl,
            {
                width: config.streamOpts.width,
                height: config.streamOpts.height,
                frameRate: config.streamOpts.fps,
                bitrateVideo: config.streamOpts.bitrateKbps,
                bitrateVideoMax: config.streamOpts.maxBitrateKbps,
                hardwareAcceleratedDecoding: config.streamOpts.hardware_acceleration,
                videoCodec: Utils.normalizeVideoCodec(config.streamOpts.videoCodec),
                customHeaders: {
                    "User-Agent": "ffmpeg",
                    Connection: "keep-alive",
                },
                customInputOptions: playback.positionSeconds > 0
                    ? ["-ss", String(playback.positionSeconds)]
                    : [],
            },
            playback.controller.signal,
        );
        playback.output = output;
        command.on("error", (error) => console.error("An error happened with ffmpeg", error));
        void promise.catch((error: unknown) => {
            if (!playback.controller.signal.aborted) console.error("FFmpeg process failed", error);
        });
        if (!playback.paused) playback.startedAt = Date.now();

        await playStream(output, streamer, { type: playback.type }, playback.controller.signal);
        if (activePlayback === playback && loopEnabled) {
            await startPlayback(playback.inputUrl, message, 0, false, playback.type, false);
        }
    } catch (error) {
        if (!playback.controller.signal.aborted) {
            console.error("Unable to play stream", error);
            await message.reply(error instanceof Error ? error.message : "Unable to play stream.");
        }
    } finally {
        if (activePlayback === playback) activePlayback = undefined;
    }
}

const VOICE_STATE_UPDATE = 4;

/** Leave the voice channel. leaveVoice() only signals guild_id: null, so also tell Discord which server. */
function leaveVoiceChannel(): boolean {
    stopPlayback();
    const wasConnected = Boolean(streamer.voiceConnection);
    streamer.leaveVoice();
    const inVoice = [...streamer.client.guilds.cache.values()].filter((g) => g.members.me?.voice.channelId);
    for (const g of inVoice) {
        streamer.sendOpcode(VOICE_STATE_UPDATE, {
            guild_id: g.id,
            channel_id: null,
            self_mute: true,
            self_deaf: false,
            self_video: false,
        });
    }
    return wasConnected || inVoice.length > 0;
}

async function joinChannel(channel: VoiceBasedChannel): Promise<void> {
    const vc = streamer.voiceConnection;
    if (vc && vc.guildId === channel.guildId && vc.channelId === channel.id) return;
    if (vc) leaveVoiceChannel();
    let timer: NodeJS.Timeout | undefined;
    try {
        await Promise.race([
            streamer.joinVoice(channel.guildId, channel.id),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Timed out joining the voice channel.")), 20_000);
            }),
        ]);
    } catch (error) {
        leaveVoiceChannel();
        throw error instanceof Error ? error : new Error(String(error));
    } finally {
        clearTimeout(timer);
    }
    if (channel instanceof StageChannel) await streamer.client.user?.voice?.setSuppressed(false);
}

function stopPlayback(): void {
    activePlayback?.controller.abort();
    activePlayback = undefined;
}

function currentPosition(playback: ActivePlayback): number {
    if (playback.paused || playback.startedAt === 0) return playback.positionSeconds;
    return playback.positionSeconds + (Date.now() - playback.startedAt) / 1000;
}

function formatTime(seconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const remainingSeconds = totalSeconds % 60;
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
        : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

async function getDuration(mediaUrl: string): Promise<number> {
    const { stdout } = await execFileAsync("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        mediaUrl,
    ]);
    const duration = Number(stdout.trim());
    if (!Number.isFinite(duration) || duration < 0) {
        throw new Error("ffprobe returned an invalid duration");
    }
    return duration;
}

async function resolveMediaUrl(input: string): Promise<string> {
    if (!/(?:youtube\.com|youtu\.be)\//i.test(input)) return input;

    console.log("Resolving YouTube media URL...");
    try {
        const cookiesFile = path.resolve(process.cwd(), "src/cookies.txt");
        const cookieArgs = existsSync(cookiesFile) ? ["--cookies", cookiesFile] : [];
        if (cookieArgs.length > 0) console.log("Using YouTube cookies from src/cookies.txt");

        const { stdout } = await execFileAsync("yt-dlp", [
            "--no-playlist",
            "--format",
            "best[acodec!=none][vcodec!=none]/best",
            ...cookieArgs,
            "--get-url",
            input,
        ]);
        const mediaUrl = stdout.trim().split(/\r?\n/)[0];
        if (!mediaUrl) throw new Error("yt-dlp returned no media URL");
        return mediaUrl;
    } catch (error) {
        throw new Error(
            "Unable to resolve this YouTube URL. Make sure yt-dlp is installed and the video is publicly accessible.",
            { cause: error },
        );
    }
}
