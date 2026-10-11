import '@krab3000/pup-player';
import type { PupVideoElement } from '@krab3000/pup-player';

const FIXTURES = [
  'h264-aac.mp4',
  'vp9-opus.webm',
  'vp8-opus.webm',
  'av1-opus.mp4',
  'hevc-ac3.mkv',
  'h264-aac.ts',
  'mpeg2-mp2.ts',
  'mpeg4-mp3.avi',
  'h264-1080p-video-only.mp4',
  'audio.flac',
  'audio.mp3',
  'audio.wav',
  'audio-opus.ogg',
];

// test-media/generate-legacy.sh
const LEGACY = [
  'legacy/ac3.ac3',
  'legacy/adpcm_ima.wav',
  'legacy/alac.caf',
  'legacy/alac.m4a',
  'legacy/cinepak-pcm.mov',
  'legacy/divx5-mp2.avi',
  'legacy/dnxhr-pcm.mov',
  'legacy/dts.dts',
  'legacy/dvvideo-pcm.dv',
  'legacy/eac3.eac3',
  'legacy/ffv1-flac.nut',
  'legacy/flashsv-nellymoser.flv',
  'legacy/flv1-adpcm_swf.flv',
  'legacy/flv1-mp3.flv',
  'legacy/g723_1.wav',
  'legacy/h263-aac.3gp',
  'legacy/huffyuv-pcm.avi',
  'legacy/mjpeg-adpcm_ima.avi',
  'legacy/mp2.mp2',
  'legacy/mpeg1-mp2.mpg',
  'legacy/mpeg2-pcm.mxf',
  'legacy/msmpeg4v2-adpcm_ms.avi',
  'legacy/msmpeg4v3-mp3.avi',
  'legacy/msvideo1-pcm_u8.avi',
  'legacy/mulaw.au',
  'legacy/pcm24.aiff',
  'legacy/prores-pcm24.mov',
  'legacy/qtrle-alac.mov',
  'legacy/real144.ra',
  'legacy/rv10-real144.rm',
  'legacy/rv20-ac3.rm',
  'legacy/snow-vorbis.mkv',
  'legacy/svq1-pcm.mov',
  'legacy/truehd.thd',
  'legacy/tta.tta',
  'legacy/wavpack.wv',
  'legacy/wmav2.wma',
  'legacy/wmv1-wmav1.asf',
  'legacy/wmv2-wmav2.wmv',
  'legacy/xvid-ac3.avi',
  'legacy/zmbv-pcm.avi',
];

// test-media/generate-hls.sh
const HLS = [
  'hls/vod-ts/index.m3u8',
  'hls/vod-fmp4/index.m3u8',
  'hls/byterange/index.m3u8',
  'hls/aes/index.m3u8',
  'hls/master/master.m3u8',
];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const pup = $<PupVideoElement>('pup');
const ref = $<HTMLVideoElement>('ref');
const fixture = $<HTMLSelectElement>('fixture');
const urlInput = $<HTMLInputElement>('url');
const fileInput = $<HTMLInputElement>('file');
const nativeToggle = $<HTMLInputElement>('native');
const log = $<HTMLOListElement>('log');

$('env').textContent = `crossOriginIsolated=${crossOriginIsolated} · ${navigator.hardwareConcurrency} cores · ${
  typeof VideoDecoder !== 'undefined' ? 'WebCodecs' : 'no WebCodecs'
}`;

const options = (list: string[]) => list.map((f) => `<option>${f}</option>`).join('');
fixture.innerHTML = `<optgroup label="Modern">${options(FIXTURES)}</optgroup><optgroup label="Legacy / exotic">${options(LEGACY)}</optgroup><optgroup label="HLS">${options(HLS)}</optgroup>`;

function loadUrl(url: string): void {
  pup.srcObject = null;
  pup.src = url;
  ref.src = nativeToggle.checked ? url : '';
}

fixture.addEventListener('change', () => loadUrl(`/media/${fixture.value}`));
urlInput.addEventListener('change', () => urlInput.value && loadUrl(urlInput.value));
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  pup.removeAttribute('src');
  pup.srcObject = file;
  ref.src = nativeToggle.checked ? URL.createObjectURL(file) : '';
});
nativeToggle.addEventListener('change', () => {
  $('native-pane').hidden = !nativeToggle.checked;
  if (!nativeToggle.checked) ref.removeAttribute('src'), ref.load();
});
$('clear').addEventListener('click', () => (log.innerHTML = ''));

const start = performance.now();
for (const type of [
  'loadstart', 'progress', 'suspend', 'abort', 'error', 'emptied', 'loadedmetadata', 'loadeddata', 'canplay',
  'canplaythrough', 'playing', 'waiting', 'seeking', 'seeked', 'ended', 'durationchange', 'play', 'pause',
  'ratechange', 'resize', 'volumechange',
]) {
  pup.addEventListener(type, () => {
    const li = document.createElement('li');
    const err = type === 'error' && pup.error ? ` (${pup.error.code}: ${pup.error.message})` : '';
    li.textContent = `${((performance.now() - start) / 1000).toFixed(3)}s ${type} t=${pup.currentTime.toFixed(3)} rs=${pup.readyState}${err}`;
    log.append(li);
    log.scrollTop = log.scrollHeight;
  });
}

const fmt = (r: TimeRanges) => Array.from({ length: r.length }, (_, i) => `[${r.start(i).toFixed(2)}, ${r.end(i).toFixed(2)}]`).join(' ');
setInterval(() => {
  const s = pup.getStats();
  $('stats').textContent = [
    `time ${pup.currentTime.toFixed(3)} / ${pup.duration.toFixed(3)}  paused=${pup.paused} ended=${pup.ended} seeking=${pup.seeking}`,
    `readyState=${pup.readyState} networkState=${pup.networkState}  ${pup.videoWidth}x${pup.videoHeight}`,
    `format=${s.format} video=${s.videoDecoder} threading=${s.threading} decodeFps=${s.decodeFps.toFixed(1)}`,
    `presented=${s.presentedFrames} dropped=${s.droppedFrames}  buffered=${fmt(pup.buffered)}  seekable=${fmt(pup.seekable)}`,
    ...(s.hls
      ? [`hls ${s.hls.kind} variant=${s.hls.variant?.resolution ?? '-'} segments=${s.hls.segmentsLoaded} reloads=${s.hls.reloads}`]
      : []),
  ].join('\n');
  $('ref-stats').textContent = ref.src
    ? `time ${ref.currentTime.toFixed(3)} / ${ref.duration.toFixed(3)}  readyState=${ref.readyState}${ref.error ? `  error ${ref.error.code}` : ''}`
    : '';
}, 200);

// Expose for console experiments and e2e tests.
Object.assign(window, { pup, ref });
// ?src=<url> opens that URL; ?empty starts with nothing loaded (e2e tests);
// ?autoplay / ?muted set those attributes on both players.
const params = new URLSearchParams(location.search);
for (const attr of ['autoplay', 'muted']) {
  if (params.has(attr)) for (const media of [pup, ref]) media.setAttribute(attr, '');
}
if (params.has('muted')) ref.muted = true;
else ref.muted = false;
if (params.has('src')) loadUrl(params.get('src')!);
else if (!params.has('empty')) loadUrl(`/media/${fixture.value}`);
