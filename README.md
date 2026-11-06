# Demo film pipeline (not part of the app)

Makes `contri-demo.mp4` (93 s, 1080p30) and `contri-thumbnail.jpg`.

1. Run the app offline: `cd app && MOCK=1 node dev/server.js` (port 8787; dev/mock.js has the sample circles).
2. Film the real screens frame by frame on a paused clock (`lib.mjs`): `node film.mjs hero scroll proof tv how privacy explore key help`
   and `SCALE=2 node film.mjs appA appB circle` (writes `frames/<clip>/*.jpg` and `events/<clip>.json`).
   Copy `instrument-sans.woff` and `instrument-serif.woff2` from `app/public/fonts` next to `stage.html`.
3. Serve this folder: `python3 -m http.server 8790`, then `node render.mjs` (6-second parts in `parts/`, writes `cues.json`).
   `node render.mjs --stills 12,30,47` renders single frames to check.
4. `python3 sound.py` (synthesised music and effects timed to cues.json and the click events).
5. Join and add sound:
   `ls parts/p*.mp4 | sed "s/^/file '/;s/$/'/" > list.txt && ffmpeg -f concat -safe 0 -i list.txt -c copy video.mp4`
   `ffmpeg -i video.mp4 -i sound.wav -map 0:v -map 1:a -c:v copy -af loudnorm=I=-14:TP=-1.5:LRA=9 -c:a aac -b:a 256k -shortest -movflags +faststart contri-demo.mp4`
6. Thumbnail: screenshot `thumb.html` at 1920x1080, scale to 1280x720.

Captions and timings are in `stage.html` (CAPS and the scene() list). Playwright is imported from
/opt/node22/lib/node_modules/playwright; change that path to wherever Playwright is installed.
