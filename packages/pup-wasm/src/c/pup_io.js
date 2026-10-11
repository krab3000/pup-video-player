// Emscripten JS library: forwards AVIO reads to Module.pupIO, which the
// demux worker installs (see src/ts/io.ts).
addToLibrary({
  pup_js_read: (io, buf, size, pos) => {
    try {
      return Module.pupIO.read(io, HEAPU8.subarray(buf, buf + size), pos);
    } catch (e) {
      err(`pup_js_read failed: ${e}`);
      return -1;
    }
  },
  pup_js_size: (io) => {
    try {
      return Module.pupIO.size(io);
    } catch (e) {
      return -1;
    }
  },
});
