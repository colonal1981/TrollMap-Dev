/**
 * catch-importer.js — Zero-Friction Catch Photo Importer (Phase 1)
 * 
 * Implements global drag-and-drop for fish photos.
 * Extracts EXIF GPS & Time -> Fetches historical weather -> Presents a clean logging modal.
 */

// Dynamically load exif-js (the rock-solid one we proved works on Android/Pixel)
const exifScript = document.createElement('script');
exifScript.src = 'https://cdn.jsdelivr.net/npm/exif-js';
document.head.appendChild(exifScript);

// --- 1. Global Drag & Drop UI Overlay ---
const dropOverlay = document.createElement('div');
dropOverlay.innerHTML = `<div style="pointer-events:none; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; border: 4px dashed #00e5ff; border-radius: 20px; background: rgba(11, 22, 35, 0.9);">
    <span style="font-size: 60px;">📸</span>
    <h2 style="color:white; margin-top:20px;">Drop Catch Photo to Import</h2>
</div>`;
Object.assign(dropOverlay.style, {
    position: 'fixed', top: '10px', left: '10px', right: '10px', bottom: '10px',
    zIndex: '999999', display: 'none', backdropFilter: 'blur(5px)', transition: 'all 0.2s'
});
document.body.appendChild(dropOverlay);

let dragCounter = 0;
document.body.addEventListener('dragenter', (e) => { e.preventDefault(); });
document.body.addEventListener('dragover', (e) => { e.preventDefault(); });
document.body.addEventListener('dragenter', () => {
    dragCounter++;
    dropOverlay.style.display = 'block';
});
document.body.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter === 0) dropOverlay.style.display = 'none';
});
document.body.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.style.display = 'none';
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        processPhoto(e.dataTransfer.files[0]);
    }
});

// --- 2. Processing Logic ---
function processPhoto(file) {
    if (!window.EXIF) {
        alert("EXIF library is still loading. Try again in 2 seconds.");
        return;
    }
    
    // Show loading modal
    showImportModal('Analyzing Photo Metadata...', file);

    EXIF.getData(file, async function() {
        try {
            let latDec = null, lonDec = null;
            let dateStr = EXIF.getTag(this, "DateTimeOriginal"); // "YYYY:MM:DD HH:MM:SS"
            
            let lat = EXIF.getTag(this, "GPSLatitude");
            let lon = EXIF.getTag(this, "GPSLongitude");
            let latRef = EXIF.getTag(this, "GPSLatitudeRef");
            let lonRef = EXIF.getTag(this, "GPSLongitudeRef");
            
            if (lat && lon) {
                latDec = lat[0] + (lat[1]/60) + (lat[2]/3600);
                lonDec = lon[0] + (lon[1]/60) + (lon[2]/3600);
                if (latRef === "S") latDec = -latDec;
                if (lonRef === "W") lonDec = -lonDec;
            }

            // Convert image to Base64 for display and DB storage
            const reader = new FileReader();
            reader.onload = async (e) => {
                const base64Img = e.target.result;
                
                // Format Date
                let isoDate = null;
                let displayDate = "Unknown Time";
                if (dateStr) {
                    // Convert "2026:06:20 12:25:59" to "2026-06-20T12:25:59"
                    const parts = dateStr.split(" ");
                    if (parts.length === 2) {
                        isoDate = `${parts[0].replace(/:/g, '-')}T${parts[1]}`;
                        displayDate = new Date(isoDate).toLocaleString();
                    }
                }

                // Fetch Historical Weather if we have GPS and Time
                let weatherStr = "Unknown (No GPS/Time)";
                if (latDec && isoDate) {
                    weatherStr = "Fetching historical weather...";
                    updateModalWeatherText(weatherStr);
                    try {
                        const dateOnly = isoDate.split('T')[0];
                        const hour = parseInt(isoDate.split('T')[1].split(':')[0]);
                        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latDec}&longitude=${lonDec}&start_date=${dateOnly}&end_date=${dateOnly}&hourly=temperature_2m,surface_pressure,cloudcover,windspeed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`;
                        
                        const wResp = await fetch(url);
                        if (wResp.ok) {
                            const wData = await wResp.json();
                            const temp = wData.hourly.temperature_2m[hour];
                            const press = wData.hourly.surface_pressure[hour];
                            const cloud = wData.hourly.cloudcover[hour];
                            const wind = wData.hourly.windspeed_10m[hour];
                            weatherStr = `${temp}°F | ${press} hPa | Wind: ${wind}mph | ${cloud}% Cloud`;
                        } else {
                            weatherStr = "Weather API failed.";
                        }
                    } catch (e) {
                        weatherStr = "Weather fetch error.";
                    }
                }

                populateImportModal(base64Img, latDec, lonDec, displayDate, isoDate, weatherStr);
            };
            reader.readAsDataURL(file);

        } catch (err) {
            alert(`Error parsing photo: ${err.message}`);
            closeImportModal();
        }
    });
}

// --- 3. UI Modal ---
let modalEl = null;

function showImportModal(statusText, file) {
    if (modalEl) modalEl.remove();
    modalEl = document.createElement('div');
    Object.assign(modalEl.style, {
        position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
        backgroundColor: 'rgba(0,0,0,0.8)', zIndex: '9999999', display: 'flex',
        alignItems: 'center', justifyContent: 'center'
    });
    
    modalEl.innerHTML = `
        <div style="background: var(--panel, #1a2634); width: 90%; max-width: 450px; border-radius: 12px; padding: 20px; color: white; box-shadow: 0 10px 30px rgba(0,0,0,0.5); font-family: system-ui;">
            <h3 style="margin-top:0; color: #00e5ff;">🐟 Process New Catch</h3>
            <div id="imp-status" style="color:#aaa; font-style:italic; margin-bottom: 15px;">${statusText}</div>
            <div id="imp-form" style="display:none; flex-direction: column; gap: 12px;">
                
                <img id="imp-img" style="width: 100%; max-height: 200px; object-fit: contain; border-radius: 8px; background: #000;" />
                
                <div style="background: rgba(255,255,255,0.05); padding: 10px; border-radius: 8px; font-size: 12px;">
                    <div style="margin-bottom: 4px;"><b>Time:</b> <span id="imp-time"></span></div>
                    <div style="margin-bottom: 4px;"><b>GPS:</b> <span id="imp-gps"></span></div>
                    <div style="margin-bottom: 4px;"><b>Weather:</b> <span id="imp-weather" style="color: #ffb703;"></span></div>
                </div>

                <div style="display: flex; gap: 10px;">
                    <div style="flex: 1;">
                        <label style="font-size:12px; color:#aaa;">Species</label>
                        <select id="imp-species" style="width:100%; padding:8px; border-radius:4px; background:#0b1623; color:white; border:1px solid #444;">
                            <option value="Striped Bass">Striped Bass</option>
                            <option value="Largemouth Bass">Largemouth Bass</option>
                            <option value="Crappie">Crappie</option>
                            <option value="Catfish">Catfish</option>
                            <option value="White Bass">White Bass</option>
                            <option value="Hybrid">Hybrid Striper</option>
                            <option value="Other">Other</option>
                        </select>
                    </div>
                    <div style="flex: 1;">
                        <label style="font-size:12px; color:#aaa;">Length (in)</label>
                        <input type="number" id="imp-length" step="0.25" placeholder="e.g. 24.5" style="width:100%; padding:8px; border-radius:4px; background:#0b1623; color:white; border:1px solid #444; box-sizing:border-box;">
                    </div>
                </div>
                
                <div style="display: flex; gap: 10px;">
                    <div style="flex: 1;">
                        <label style="font-size:12px; color:#aaa;">Depth (ft)</label>
                        <input type="number" id="imp-depth" placeholder="e.g. 18" style="width:100%; padding:8px; border-radius:4px; background:#0b1623; color:white; border:1px solid #444; box-sizing:border-box;">
                    </div>
                    <div style="flex: 1;">
                        <label style="font-size:12px; color:#aaa;">Lure</label>
                        <input type="text" id="imp-lure" placeholder="e.g. Bucktail" style="width:100%; padding:8px; border-radius:4px; background:#0b1623; color:white; border:1px solid #444; box-sizing:border-box;">
                    </div>
                </div>

                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <button id="imp-cancel" style="flex: 1; padding: 10px; background: transparent; color: white; border: 1px solid #666; border-radius: 6px; cursor: pointer;">Cancel</button>
                    <button id="imp-save" style="flex: 2; padding: 10px; background: #00e5ff; color: #062d00; border: none; border-radius: 6px; font-weight: bold; cursor: pointer;">Save to Journal</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modalEl);

    document.getElementById('imp-cancel').addEventListener('click', closeImportModal);
}

function updateModalWeatherText(text) {
    const wEl = document.getElementById('imp-weather');
    if (wEl) wEl.textContent = text;
}

let currentCatchData = {};

function populateImportModal(base64Img, lat, lon, displayTime, isoDate, weather) {
    document.getElementById('imp-status').style.display = 'none';
    document.getElementById('imp-form').style.display = 'flex';
    
    document.getElementById('imp-img').src = base64Img;
    document.getElementById('imp-time').textContent = displayTime;
    
    if (lat && lon) {
        document.getElementById('imp-gps').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    } else {
        document.getElementById('imp-gps').textContent = `Missing (Android Privacy Strip or Settings)`;
        document.getElementById('imp-gps').style.color = '#ff5252';
    }
    
    document.getElementById('imp-weather').textContent = weather;

    currentCatchData = {
        photo: base64Img,
        lat: lat,
        lon: lon,
        timestamp: isoDate,
        weatherStr: weather
    };

    document.getElementById('imp-save').addEventListener('click', saveCatchToDB);
}

async function saveCatchToDB() {
    const species = document.getElementById('imp-species').value;
    const length = document.getElementById('imp-length').value;
    const depth = document.getElementById('imp-depth').value;
    const lure = document.getElementById('imp-lure').value;

    const catchEntry = {
        id: Date.now(),
        species,
        length: length ? parseFloat(length) : null,
        depth: depth ? parseFloat(depth) : null,
        lure,
        lat: currentCatchData.lat,
        lon: currentCatchData.lon,
        time: currentCatchData.timestamp,
        weather: currentCatchData.weatherStr,
        photoUrl: currentCatchData.photo, // Base64 stored for now
        synced: false
    };

    // Attempt to save using the global DB module if it exists
    if (window.DB && window.DB.put) {
        try {
            await window.DB.put('catches', catchEntry);
            
            // Plot on map if state.MAP is available
            if (window.state && window.state.MAP && catchEntry.lat) {
                const L = window.L;
                L.marker([catchEntry.lat, catchEntry.lon], {
                    icon: L.divIcon({
                        className: 'catch-marker',
                        html: `<div style="background:#ff9800;border-radius:50%;width:12px;height:12px;border:2px solid #fff;"></div>`
                    })
                }).addTo(window.state.MAP).bindPopup(`<b>${species}</b><br>${length}" | ${catchEntry.weather}`);
            }
            alert("Catch Saved to Journal!");
            closeImportModal();
        } catch (e) {
            alert("Error saving to IndexedDB: " + e.message);
        }
    } else {
        alert("Database module not found! Catch data logged to console.");
        console.log("CATCH DATA:", catchEntry);
        closeImportModal();
    }
}

function closeImportModal() {
    if (modalEl) {
        modalEl.remove();
        modalEl = null;
    }
}

console.log("✓ Zero-Friction Catch Importer armed (Global Drag & Drop)");
