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
      "    this._refreshViews();\n" +
      "    if(!Buffer.isBuffer(buffer) || !Number.isInteger(frameSize) || frameSize < 1 || frameSize > MAX_FRAME_SIZE || buffer.length !== frameSize * this.channels * 2 || buffer.length > this.inPCMLength) throw new RangeError('Encode error: Invalid PCM frame');\n" +
      // The native loop reads 2 * byteCount uint16 slots while packing input
      // in place. Only byteCount/2 packed samples form the actual PCM frame.
      "    this.inPCM.fill(0, buffer.length, buffer.length * 2);\n    this.inPCM.set(buffer);"],
    ["OpusScript.prototype.decode = function decode(buffer) {\n    this.inOpus.set(buffer);",
      "OpusScript.prototype.decode = function decode(buffer) {\n" +
      "    this._refreshViews();\n" +
      "    if(!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > MAX_PACKET_SIZE) throw new RangeError('Decode error: Invalid packet');\n    this.inOpus.set(buffer);"],
  ];
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error("OpusScript source changed; review the pinned PCM memory repair.");
    source = source.replace(before, after);
  }
  // Emscripten replaces its heap buffer when another instance grows memory.
  // Per-instance views then point into a detached buffer, including when a
  // constructor's later allocations grew the heap after its first view.
  const refresh = `
OpusScript.prototype._refreshViews = function() {
    if(this._deleted) throw new Error('Opus codec has been deleted');
    const native = this.options.wasm ? opusscript_native_wasm : opusscript_native_nasm;
    this.inPCM = native.HEAPU16.subarray(this.inPCMPointer / 2, this.inPCMPointer / 2 + this.inPCMLength * 2);
    this.inOpus = native.HEAPU8.subarray(this.inOpusPointer, this.inOpusPointer + MAX_PACKET_SIZE);
    this.outOpus = native.HEAPU8.subarray(this.outOpusPointer, this.outOpusPointer + MAX_PACKET_SIZE);
    this.outPCM = native.HEAPU16.subarray(this.outPCMPointer / 2, this.outPCMPointer / 2 + this.outPCMLength);
};
`;
  const deletion = "OpusScript.prototype.delete = function del() {";
  if (source.split(deletion).length !== 2) throw new Error("Review OpusScript codec disposal.");
  source = source.replace(deletion, deletion + "\n    if(this._deleted) return;\n    this._deleted = true;");
  return "// VC-Discord: repaired PCM heap addressing, allocation bounds, frame limits and heap growth.\n" + source + refresh;
}
