// Worker/cameras.js — the current frame from a USGS NIMS camera.
//
// Personal use only, not for distribution or resale; not for navigation.
//
//   GET /cameras/frame?camId=SC_Congaree_River_below_Cayce_DOWNSTREAM_CAMERA
//     -> { camId, capturedAt, ageMinutes, stale, period, urls: { small, thumb, overlay, tl } }
//
// WHAT THIS ROUTE IS AND IS NOT
//   The camera ROSTER is baked into js/data/cameras.js by Scripts/build_camera_index.py — it
//   is 52 records for our four states and NIMS's own createdDate/modifiedDate are 2023, so
//   shipping it live would mean sending 1,281 national records to a phone at a boat ramp to
//   use 52 of them. Only the current FRAME is live, and that is all this route serves.
//
// WHY IT RETURNS A URL AND NOT AN IMAGE
//   The open question left by NIMS_CAMERAS_2026-08-06.md was "does the S3 bucket send CORS
//   headers to a browser". It does not matter for this design: CORS governs fetch() and canvas
//   readback, NOT <img src>. A cross-origin image has always been allowed to DISPLAY; it is
//   only reading its pixels back that is gated. So the front end sets img.src to the URL below
//   and no proxy is involved, which also means no Worker bandwidth is spent on image bytes.
//
//   The one thing that WOULD break this is Referer-based hotlink protection on the bucket,
//   which is a different mechanism from CORS and is unlikely on a Public Domain USGS asset.
//   If frames ever fail to load in the browser while this route reports them fine, that is the
//   cause, and the fix is a second branch here that streams the bytes. Not built today,
//   because building it now means guessing at a failure that has not happened.
//
// THE FILENAME IS DERIVABLE — listFiles IS NOT NEEDED
//   /nims/v0/listFiles?camId=… exists and returns real filenames, but every one of them is
//   `{camId}___{YYYY-MM-DDTHH-MM-SSZ}.jpg` and the timestamp is `newestImageDT` with the
//   fractional seconds dropped and the time colons swapped for hyphens. Verified exact against
//   Congaree below Cayce: 2026-08-05T14:15:02.000Z -> ..._2026-08-05T14-15-02Z.jpg. One
//   /cameras?camId= call yields both the prefix and the filename, so this makes one request
//   per popup, not two.

const NIMS = "https://api.waterdata.usgs.gov/nims/v0";
const S3 = "https://usgs-nims-images.s3.amazonaws.com";

// Frames land every 5, 15 or 60 minutes depending on the camera. Two minutes of edge cache
// cannot hide a new frame for long and collapses a burst of popups into one upstream call.
const EDGE_TTL = 120;

// 22 of the 47 visible cameras in our footprint run `period: "daylight"`. Open a popup at
// 22:00 on one of those and the newest frame is from 20:15 — a real image, correctly served,
// and completely misleading unless the age travels with it. `stale` is computed here rather
// than in the browser so every consumer agrees on the threshold.
const STALE_MIN = 90;

function json(body, status = 200, ttl = 0) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": ttl ? `public, max-age=${ttl}` : "no-store",
  };
  return new Response(JSON.stringify(body), { status, headers });
}

// `2026-08-05T14:15:02.000Z` -> `2026-08-05T14-15-02Z`
// Only the TIME colons may be swapped; the date's hyphens are already hyphens and touching the
// whole string with a blanket replace would turn the separator into a hyphen too.
export function frameStamp(newestImageDT) {
  const s = String(newestImageDT || "").trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return `${m[1]}T${m[2]}-${m[3]}-${m[4]}Z`;
}

export function frameUrls(camId, stamp) {
  const file = `${camId}___${stamp}.jpg`;
  return {
    small: `${S3}/720/${camId}/${file}`,
    thumb: `${S3}/thumbnail/${camId}/${file}`,
    overlay: `${S3}/overlay/${camId}/${file}`,
    tl: `${S3}/timelapse/${camId}/`,
  };
}

// The roster is a bare array or a wrapped one depending on the endpoint; both shapes have been
// seen. Reading `[0]` off the wrong shape yields undefined and reports "camera not found" for
// a camera that is right there, so find the list rather than assuming it.
function rowsOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const k of ["cameras", "data", "items", "records", "results"]) {
      if (Array.isArray(payload[k])) return payload[k];
    }
  }
  return [];
}

export async function handleCameraFrame(request, env, url) {
  const camId = (url.searchParams.get("camId") || "").trim();
  if (!camId) return json({ error: "camId required" }, 400);
  // The id goes into a query string on an upstream call and into a URL path on the way back.
  // NIMS ids are underscore-and-alphanumeric by construction; anything else is not a camera id
  // and should not be echoed anywhere.
  if (!/^[A-Za-z0-9_.-]{3,120}$/.test(camId)) {
    return json({ error: "bad camId" }, 400);
  }

  let payload;
  try {
    const res = await fetch(`${NIMS}/cameras?camId=${encodeURIComponent(camId)}`, {
      headers: { accept: "application/json", "user-agent": "TrollMap/1.0 (personal)" },
      cf: { cacheTtl: EDGE_TTL, cacheEverything: true },
    });
    if (!res.ok) return json({ error: `nims ${res.status}`, camId }, 502);
    payload = await res.json();
  } catch (err) {
    return json({ error: "nims unreachable", detail: String(err), camId }, 502);
  }

  const rec = rowsOf(payload).find(
    (r) => r && String(r.camId || r.cameraId || r.id || "") === camId
  );
  if (!rec) return json({ error: "camera not found", camId }, 404);

  const newest = rec.newestImageDT || rec.newestImage || rec.lastImageDT || null;
  const stamp = frameStamp(newest);
  if (!stamp) {
    // A camera that exists but has never produced a frame, or one whose timestamp field has
    // drifted. Say which, rather than returning a URL that 404s in an <img> with no message.
    return json({ camId, capturedAt: newest, error: "no readable frame timestamp" }, 200, EDGE_TTL);
  }

  const capturedMs = Date.parse(newest);
  const ageMinutes = Number.isFinite(capturedMs)
    ? Math.max(0, Math.round((Date.now() - capturedMs) / 60000))
    : null;
  const ingest = rec.ingest && typeof rec.ingest === "object" ? rec.ingest : {};

  return json(
    {
      camId,
      // camName/camDesc are what the roster actually carries; the rest are fallbacks.
      name: rec.camName || rec.camDesc || rec.cameraDescription || rec.siteName || camId,
      nwisId: rec.nwisId || rec.siteId || null,
      capturedAt: newest,
      ageMinutes,
      stale: ageMinutes != null && ageMinutes > STALE_MIN,
      period: ingest.period || rec.period || "247",
      intervalMin: ingest.intr || rec.intr || null,
      urls: frameUrls(camId, stamp),
    },
    200,
    EDGE_TTL
  );
}

// Single entry point, same shape as water.js and conditions.js: returns a Response when it
// owns the path and null when it does not, so the router can fall through without knowing
// anything about this module's internals.
export function handleCameras(request, env, url) {
  const p = url.pathname;
  if (p === "/cameras/frame" && request.method === "GET") {
    return handleCameraFrame(request, env, url);
  }
  return null;
}

// Same shape as WATER_ROUTES and CONDITIONS_ROUTES: a plain list of what this module answers,
// so the route inventory does not have to be reconstructed by reading the router.
export const CAMERA_ROUTES = [
  '/cameras/frame?camId=<id>   -> { capturedAt, ageMinutes, stale, urls:{small,thumb,overlay,tl} }',
];
