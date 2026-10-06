// Backport RTP CSRC/extension parsing from discordjs/discord.js, Apache-2.0.
// Upstream: 4dc1acc60, packages/voice/src/receive/VoiceReceiver.ts.
// Keep stable @discordjs/voice 0.19.2: current main requires Node.js 24.17.
export function patchVoiceReceiverSource(source) {
  const replacements = [
    [
      'let headerSize = 12;\n    const first = buffer.readUint8();\n    if (first >> 4 & 1) headerSize += 4;',
      'const first = buffer.readUint8();\n    let headerSize = 12 + 4 * (first & 15);\n    if (first & 16) headerSize += 4;\n    if (buffer.length < headerSize + AUTH_TAG_LENGTH + UNPADDED_NONCE_LENGTH) throw new Error("Invalid RTP header");',
    ],
    [
      'if (buffer.subarray(12, 14).compare(HEADER_EXTENSION_BYTE) === 0) {\n      const headerExtensionLength = buffer.subarray(14).readUInt16BE();\n      packet = packet.subarray(4 * headerExtensionLength);\n    }',
      'if (buffer[0] & 16) {\n      const extensionOffset = 12 + 4 * (buffer[0] & 15);\n      const extensionBytes = 4 * buffer.readUInt16BE(extensionOffset + 2);\n      if (extensionBytes > packet.length) throw new Error("Invalid RTP extension");\n      packet = packet.subarray(extensionBytes);\n    }',
    ],
    ['if (msg.length <= 8) return;', 'if (msg.length < 12) return;'],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error('Voice receiver source changed; review the pinned RTP compatibility patch.');
    source = source.replace(before, after);
  }
  return source;
}

export const voiceCompatibility = {
  name: 'discord-voice-rtp-compatibility',
  setup(builder) {
    builder.onLoad({ filter: /[\\/]@discordjs[\\/]voice[\\/]dist[\\/]index\.m?js$/ }, async ({ path }) => {
      const { readFile } = await import('node:fs/promises');
      return { contents: patchVoiceReceiverSource(await readFile(path, 'utf8')), loader: 'js' };
    });
  },
};
