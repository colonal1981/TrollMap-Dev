/**
 * autopilot-ble.js -- the Bluetooth link to the steering box ("TrollMap Autopilot", the Nano ESP32).
 *
 * Personal use only, not for distribution or resale; not for navigation.
 *
 * The box is a Nordic-UART-style service (garage_test.ino): the phone writes commands to RX, the box
 * notifies lines on TX in pieces of up to 20 bytes, each line ending "\n". Web Bluetooth, from the page,
 * the same way the battery reader connects (ble-motor.js) -- Chrome on the Pixel. NEVER pair it in
 * Android's Bluetooth settings: a bonded box is held by the phone and the page cannot reach it.
 *
 * A DROPPED LINK DOES NOT STOP THE BOX. Ryan, 2026-11-26: "keep following" -- the box keeps holding or
 * following on its own GPS and compass, and the phone is a display. So a drop here is only the panel
 * going quiet: it reconnects to the same box every few seconds without asking, for as long as the panel
 * is open.
 */
export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';   // the phone writes here
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';   // the box notifies here
const CHUNK = 20;
const RECONNECT_MS = 4000;

export function createLink({ onLine = () => {}, onState = () => {} } = {}) {
  let device = null;
  let rx = null;
  let buf = '';
  let queue = Promise.resolve();
  let wanted = false;          // the person asked for a connection and has not asked to drop it
  let retry = 0;
  let state = 'off';           // off | connecting | on | lost
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  const setState = (s, why = '') => { state = s; onState(s, why); };

  const onNotify = (ev) => {
    buf += dec.decode(ev.target.value);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
    if (buf.length > 512) buf = '';      // a line that never ended is not a line
  };

  async function attach() {
    setState('connecting');
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(NUS_SERVICE);
    rx = await svc.getCharacteristic(NUS_RX);
    const tx = await svc.getCharacteristic(NUS_TX);
    tx.addEventListener('characteristicvaluechanged', onNotify);
    await tx.startNotifications();
    buf = '';
    setState('on');
  }

  function onDisconnected() {
    rx = null;
    if (!wanted) { setState('off'); return; }
    setState('lost', 'the box keeps steering on its own; reconnecting');
    clearTimeout(retry);
    retry = setTimeout(reconnect, RECONNECT_MS);
  }

  async function reconnect() {
    if (!wanted || !device || state === 'on') return;
    try { await attach(); } catch (e) {
      setState('lost', `reconnecting (${(e && e.message) || e})`);
      retry = setTimeout(reconnect, RECONNECT_MS);
    }
  }

  return {
    get state() { return state; },
    get name() { return device ? device.name : ''; },
    available: () => typeof navigator !== 'undefined' && !!navigator.bluetooth,

    /** Must be called from a tap: Chrome only shows the chooser for a user gesture. */
    async connect() {
      if (!navigator.bluetooth) throw new Error('Web Bluetooth is not available here -- use Chrome on the phone, over https');
      wanted = true;
      if (!device) {
        device = await navigator.bluetooth.requestDevice({
          filters: [{ services: [NUS_SERVICE] }, { name: 'TrollMap Autopilot' }],
          optionalServices: [NUS_SERVICE],
        });
        device.addEventListener('gattserverdisconnected', onDisconnected);
      }
      try { await attach(); } catch (e) { setState('off', (e && e.message) || String(e)); throw e; }
    },

    disconnect() {
      wanted = false;
      clearTimeout(retry);
      if (device && device.gatt.connected) device.gatt.disconnect();
      else setState('off');
    },

    /**
     * Send text, in order, 20 bytes a write, each acknowledged by the box before the next. Resolves when
     * this text has gone; rejects if the link is down.
     */
    send(text) {
      const bytes = enc.encode(String(text));
      const job = queue.then(async () => {
        if (!rx) throw new Error('not connected');
        for (let i = 0; i < bytes.length; i += CHUNK) {
          const piece = bytes.slice(i, i + CHUNK);
          if (rx.writeValueWithResponse) await rx.writeValueWithResponse(piece);
          else await rx.writeValue(piece);
        }
      });
      queue = job.catch(() => {});
      return job;
    },
  };
}
