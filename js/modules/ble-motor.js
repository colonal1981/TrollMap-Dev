/**
 * BLE Motor — XZNY / JBD / Xiaoxiang-style BMS pairing via Web Bluetooth API.
 * Reads voltage, current, SOC, remaining Ah, cell voltages, and temperature.
 * Falls back to a static simulation when Web Bluetooth is unavailable.
 *
 * Exposes window.ACTIVE_BLE_BMS = { connected, name, voltage, current,
 *   soc, usableAh, ... } so the Plan UI can display the active BMS feed.
 */

/* ── Embedded Integrated Web Bluetooth BLE pairing Engine ── */
(function initEmbeddedWebBluetooth(){
  setTimeout(() => {
    const btnPair   = document.getElementById('btnEmbedPairBle');
    const boxEl     = document.getElementById('embedBleAssessmentBox');
    const ebName    = document.getElementById('ebName');
    const ebSoc     = document.getElementById('ebSoc');
    const ebVolts   = document.getElementById('ebVolts');
    const ebAmps    = document.getElementById('ebAmps');
    const ebRemAh   = document.getElementById('ebRemAh');
    const ebSprint  = document.getElementById('ebSprintTime');

    if(!btnPair) return;

    window.ACTIVE_BLE_BMS = {
      connected: false,
      name: "XZNY 24V Battery Simulation",
      soc: 100,
      voltage: 26.4,
      current: 0.0,
      usableAh: 80.0
    };

    let gattServer = null;

    btnPair.addEventListener('click', async () => {
      if(!navigator.bluetooth){
        alert('Web Bluetooth API is not available or not enabled in this browser.\n\n• Ensure you are serving via HTTPS or localhost.\n• On iOS/iPhone, Apple restricts Web Bluetooth in Safari; use a free app like WebBLE or Bluefy to pair natively.');
        return;
      }

      try {
        btnPair.textContent = 'Pairing BLE Client…';
        btnPair.style.background = 'var(--warn)';

        // Relaxed discovery - accepts your battery even if name is "P21S001HL21S100A" or similar
        const device = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: [
            '0000ff00-0000-1000-8000-00805f9b34fb',
            '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
          ]
        });

        if(!device){
          btnPair.textContent = '⚡ Live Web Bluetooth Pair';
          btnPair.style.background = 'var(--accent2)';
          return;
        }

        gattServer = await device.gatt.connect();
        
        window.ACTIVE_BLE_BMS.connected = true;
        window.ACTIVE_BLE_BMS.name = device.name;

        btnPair.textContent = `✓ Flawlessly Paired: ${device.name.slice(0, 10)}`;
        btnPair.style.background = 'var(--panel2)';
        btnPair.style.color = 'var(--accent2)';

        if(boxEl) boxEl.style.display = 'block';
        if(ebName) ebName.textContent = `Active Connected BLE GATT feed: ${device.name}`;

        device.addEventListener('gattserverdisconnected', () => {
          window.ACTIVE_BLE_BMS.connected = false;
          window.ACTIVE_BLE_BMS.name = "Offline Simulation Mode";
          gattServer = null;
          if(boxEl) boxEl.style.display = 'none';
          btnPair.textContent = '⚡ Live Web Bluetooth Pair';
          btnPair.style.background = 'var(--accent2)';
          btnPair.style.color = '#000';
          alert('⚠ Bluetooth BMS Server Disconnected. Returned to local standard models.');
        });

        // XZNY uses a JBD/Xiaoxiang-style BMS protocol:
        // service FF00, notify/read FF01, write-no-response FF02.
        // We subscribe to FF01, write safe read requests to FF02, then decode packets.
        try {
          const service = await gattServer.getPrimaryService('0000ff00-0000-1000-8000-00805f9b34fb');
          const rx = await service.getCharacteristic('0000ff01-0000-1000-8000-00805f9b34fb');
          const tx = await service.getCharacteristic('0000ff02-0000-1000-8000-00805f9b34fb');
          let bmsBuf = [];
          let lastPoll = 0;
          const CMD_BASIC = new Uint8Array([0xDD,0xA5,0x03,0x00,0xFF,0xFD,0x77]);
          const CMD_CELLS = new Uint8Array([0xDD,0xA5,0x04,0x00,0xFF,0xFC,0x77]);
          const CMD_VER   = new Uint8Array([0xDD,0xA5,0x05,0x00,0xFF,0xFB,0x77]);
          const u16=(a,i)=>(a[i]<<8)|a[i+1];
          const i16=(a,i)=>{ let v=u16(a,i); return v>32767?v-65536:v; };
          const writeCmd = async cmd => {
            if(tx.writeValueWithoutResponse) await tx.writeValueWithoutResponse(cmd);
            else await tx.writeValue(cmd);
          };
          function updateDisplayFromBasic(d){
            const voltage = u16(d,0)/100;
            const current = i16(d,2)/100;
            const draw = Math.abs(current);
            const remAh = u16(d,4)/100;
            const capAh = u16(d,6)/100;
            const cycles = u16(d,8);
            const soc = d[19];
            const fet = d[20];
            const cells = d[21];
            const ntc = d[22];
            const temps=[];
            for(let k=0;k<ntc && 23+k*2+1<d.length;k++) temps.push((u16(d,23+k*2)/10-273.15));
            const usable = Math.max(0, remAh - capAh*0.20);
            window.ACTIVE_BLE_BMS.voltage  = voltage;
            window.ACTIVE_BLE_BMS.current  = draw;
            window.ACTIVE_BLE_BMS.soc      = soc;
            window.ACTIVE_BLE_BMS.usableAh = usable;
            window.ACTIVE_BLE_BMS.remainingAh = remAh;
            window.ACTIVE_BLE_BMS.capacityAh = capAh;
            window.ACTIVE_BLE_BMS.cycles = cycles;
            window.ACTIVE_BLE_BMS.cells = cells;
            window.ACTIVE_BLE_BMS.tempsC = temps;
            if(ebSoc)   ebSoc.textContent   = `${soc}% SOC`;
            if(ebVolts) ebVolts.textContent = `${voltage.toFixed(1)}V`;
            if(ebAmps)  ebAmps.textContent  = `Live Draw: ${draw.toFixed(1)}A (${Math.round(voltage*draw)}W)`;
            if(ebRemAh) ebRemAh.textContent = `Remaining: ${remAh.toFixed(1)} Ah / ${capAh.toFixed(0)} Ah · Usable reserve: ${usable.toFixed(1)} Ah`;
            if(ebSprint){
              const runtime = draw > 0.1 ? `${(usable/draw).toFixed(1)} hrs usable @ current load` : 'Standby / no meaningful draw';
              const tempStr = temps.length ? ` · Temp ${temps[0].toFixed(1)}°C` : '';
              ebSprint.innerHTML = `🔋 XZNY BMS live: <b>${runtime}</b> · Cycles ${cycles} · Cells ${cells}${tempStr}`;
            }
          }
          function updateCells(d){
            const cells=[];
            for(let i=0;i+1<d.length;i+=2) cells.push(u16(d,i)/1000);
            window.ACTIVE_BLE_BMS.cellVolts = cells;
          }
          function parsePacket(pkt){
            const cmd=pkt[1], status=pkt[2], len=pkt[3], d=pkt.slice(4,4+len);
            if(status!==0) return;
            if(cmd===0x03 && len>=23) updateDisplayFromBasic(d);
            else if(cmd===0x04) updateCells(d);
            else if(cmd===0x05){
              const txt=String.fromCharCode(...d.filter(x=>x>=32&&x<=126));
              if(txt && ebName) ebName.textContent = `XZNY BMS: ${txt}`;
            }
          }
          function feed(bytes){
            bmsBuf.push(...bytes);
            while(bmsBuf.length){
              const st=bmsBuf.indexOf(0xDD);
              if(st<0){ bmsBuf=[]; return; }
              if(st>0) bmsBuf.splice(0,st);
              if(bmsBuf.length<7) return;
              const len=bmsBuf[3];
              const total=7+len;
              if(bmsBuf.length<total) return;
              const pkt=bmsBuf.slice(0,total);
              bmsBuf.splice(0,total);
              if(pkt[pkt.length-1]===0x77) parsePacket(pkt);
            }
          }
          rx.addEventListener('characteristicvaluechanged', evt=>{
            const v=evt.target.value;
            feed([...new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset+v.byteLength))]);
          });
          await rx.startNotifications();
          async function pollBms(){
            if(!gattServer || !gattServer.connected) return;
            try{
              await writeCmd(CMD_BASIC);
              setTimeout(()=>writeCmd(CMD_CELLS).catch(()=>{}),250);
            }catch(e){ console.warn('BMS poll failed', e); }
          }
          await writeCmd(CMD_VER).catch(()=>{});
          await pollBms();
          lastPoll = setInterval(pollBms, 3000);
          device.addEventListener('gattserverdisconnected',()=>{ if(lastPoll) clearInterval(lastPoll); });
        } catch(charErr){
          console.warn('XZNY/JBD BMS live decode failed:', charErr);
          window.ACTIVE_BLE_BMS.voltage  = 26.4;
          window.ACTIVE_BLE_BMS.current  = 0.0;
          window.ACTIVE_BLE_BMS.soc      = 100;
          window.ACTIVE_BLE_BMS.usableAh = 80.0;
          if(ebSoc)   ebSoc.textContent   = 'BMS decode failed';
          if(ebVolts) ebVolts.textContent = '—';
          if(ebAmps)  ebAmps.textContent  = 'Could not read XZNY telemetry';
          if(ebRemAh) ebRemAh.textContent = 'Open with Android Chrome over HTTPS and retry';
          if(ebSprint) ebSprint.innerHTML = '⚠ XZNY BMS characteristic decode failed.';
        }

      } catch(bleErr){
        console.warn('Integrated BLE connection canceled:', bleErr);
        btnPair.textContent = '⚡ Live Web Bluetooth Pair';
        btnPair.style.background = 'var(--accent2)';
      }
    });
  }, 1200);
})();


/* ── Autonomous "Wet Hands" Bluetooth Media Remote & Gamepad Hub (Module J) ── */
