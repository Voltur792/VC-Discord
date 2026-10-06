// Repair the JavaScript bridge of the pinned OpusScript 0.1.1 (MIT).
// Its C++ bridge expands each PCM byte into a uint16 slot. malloc addresses
// are byte addresses, whereas HEAPU16.subarray indexes are uint16 indexes.
// https://github.com/abalabahaha/opusscript/blob/master/src/opusscript_encoder.cpp
export function patchOpusScriptSource(source) {
  source = source.replace(/\r\n/g, "\n");
  const replacements = [
    ["var MAX_FRAME_SIZE = 48000 * 60 / 1000;", "var MAX_FRAME_SIZE = 48000 * 120 / 1000;"],
    ["this.channels = channels || 1;", "this.channels = channels || 1;\n    if(this.channels !== 1 && this.channels !== 2) throw new RangeError('Invalid Opus channel count');"],
    ["this.inPCMPointer = opusscript_native._malloc(this.inPCMLength);", "this.inPCMPointer = opusscript_native._malloc(this.inPCMLength * 4);"],
    ["this.inPCM = opusscript_native.HEAPU16.subarray(this.inPCMPointer, this.inPCMPointer + this.inPCMLength);",
      "this.inPCM = opusscript_native.HEAPU16.subarray(this.inPCMPointer / 2, this.inPCMPointer / 2 + this.inPCMLength * 2);"],
    ["this.outPCMPointer = opusscript_native._malloc(this.outPCMLength);", "this.outPCMPointer = opusscript_native._malloc(this.outPCMLength * 2);"],
    ["this.outPCM = opusscript_native.HEAPU16.subarray(this.outPCMPointer, this.outPCMPointer + this.outPCMLength);",
      "this.outPCM = opusscript_native.HEAPU16.subarray(this.outPCMPointer / 2, this.outPCMPointer / 2 + this.outPCMLength);"],
    ["OpusScript.prototype.encode = function encode(buffer, frameSize) {\n    this.inPCM.set(buffer);",
      "OpusScript.prototype.encode = function encode(buffer, frameSize) {\n" +
      "    if(!Buffer.isBuffer(buffer) || !Number.isInteger(frameSize) || frameSize < 1 || frameSize > MAX_FRAME_SIZE || buffer.length !== frameSize * this.channels * 2 || buffer.length > this.inPCMLength) throw new RangeError('Encode error: Invalid PCM frame');\n" +
      // The native loop reads 2 * byteCount uint16 slots while packing input
      // in place. Only byteCount/2 packed samples form the actual PCM frame.
      "    this.inPCM.fill(0, buffer.length, buffer.length * 2);\n    this.inPCM.set(buffer);"],
    ["OpusScript.prototype.decode = function decode(buffer) {\n    this.inOpus.set(buffer);",
      "OpusScript.prototype.decode = function decode(buffer) {\n" +
      "    if(!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_PACKET_SIZE) throw new RangeError('Decode error: Invalid packet');\n    this.inOpus.set(buffer);"],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error("OpusScript source changed; review the pinned PCM memory repair.");
    source = source.replace(before, after);
  }
  return "// VC-Discord: repaired PCM heap addressing, allocation bounds and frame limits.\n" + source;
}
