import { MP4, QTFF, CustomSource, EncodedPacketSink, Input, VideoSample } from "mediabunny";
import { createVideoByteReader } from "./video-byte-ranges";

// 共享容器索引和解码器，每次只解码一个可独立解码的关键帧。
export async function createKeyframeSource(src: string, size: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const controller = new AbortController();
  const input = new Input({ formats: [MP4, QTFF], source: new CustomSource({
    getSize: () => size, read: createVideoByteReader(src, size, controller.signal),
    prefetchProfile: "none", maxCacheSize: 8 * 1024 * 1024, dispose: () => controller.abort(),
  }) });
  let decoder: VideoDecoder | undefined;
  let frame: VideoFrame | undefined;
  let decoderError: DOMException | undefined;
  const dispose = () => {
    signal.removeEventListener("abort", dispose);
    input.dispose();
    if (decoder && decoder.state !== "closed") decoder.close();
    frame?.close(); frame = undefined;
  };
  signal.addEventListener("abort", dispose, { once: true });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("视频没有可用轨道");
    const duration = await track.getDurationFromMetadata();
    if (!duration || !Number.isFinite(duration)) throw new Error("容器缺少可直接读取的时长索引");
    const config = await track.getDecoderConfig();
    if (!config || !(await VideoDecoder.isConfigSupported(config)).supported) throw new Error("当前 WebView 不支持此视频的关键帧解码");
    const rotation = await track.getRotation();
    const flip = await track.getFlip();
    signal.throwIfAborted();
    const packets = new EncodedPacketSink(track);
    decoder = new VideoDecoder({ output: output => { frame?.close(); frame = output; }, error: error => { decoderError = error; } });
    decoder.configure(config);
    return {
      dispose,
      getDuration: () => Promise.resolve(duration),
      async read(requestedPosition: number) {
        signal.throwIfAborted();
        let packet = await packets.getKeyPacket(requestedPosition, { verifyKeyPackets: true }) ?? await packets.getFirstKeyPacket({ verifyKeyPackets: true });
        while (packet && packet.timestamp < 0) packet = await packets.getNextKeyPacket(packet, { verifyKeyPackets: true });
        if (!packet) throw new Error("视频没有可用关键帧");
        const keyPacket = packet;
        return {
          position: packet.timestamp,
          async draw(maxWidth?: number) {
            signal.throwIfAborted();
            decoder!.decode(keyPacket.toEncodedVideoChunk());
            await decoder!.flush();
            if (decoderError) throw decoderError;
            if (!frame) throw new Error("关键帧没有产生画面");
            const sample = new VideoSample(frame, { rotation, flip });
            const decodedFrame = frame; frame = undefined;
            try {
              signal.throwIfAborted();
              const canvas = document.createElement("canvas");
              canvas.width = maxWidth ? Math.min(maxWidth, sample.displayWidth) : sample.displayWidth;
              canvas.height = Math.max(1, Math.round(sample.displayHeight * canvas.width / sample.displayWidth));
              const context = canvas.getContext("2d");
              if (!context) throw new Error("无法创建截图画布");
              sample.draw(context, 0, 0, canvas.width, canvas.height);
              return canvas;
            } finally { sample.close(); decodedFrame.close(); }
          },
        };
      },
    };
  } catch (error) { dispose(); signal.throwIfAborted(); throw error; }
}
