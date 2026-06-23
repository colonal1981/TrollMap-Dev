/**
 * Auto-Crop — strips the phone status bar and Navionics zoom controls
 * off the top of a loaded chart image so it aligns cleanly on the map.
 */

(function initAutoCrop(){
  setTimeout(() => {
    const btn = document.getElementById('autoCropImgBtn');
    if(!btn) return;
    btn.addEventListener('click', () => {
      if(!IMG_OVERLAY || !IMG_DATAURL){
        alert('Load a chart image first, then click ✂ Auto-Crop.');
        return;
      }
      const img = new Image();
      img.onload = () => {
        // Remove top 80px (phone status bar) and right 120px (Navionics zoom controls)
        const cropTop = 80, cropRight = 120;
        const canvas = document.createElement('canvas');
        canvas.width  = img.width - cropRight;
        canvas.height = img.height - cropTop;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, cropTop, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
        IMG_DATAURL = canvas.toDataURL('image/jpeg', 0.92);
        IMG_NATSIZE = { w: canvas.width, h: canvas.height };
        placeProvisionalOverlay();
        btn.style.background = 'var(--accent2)';
        btn.style.color = '#000';
        setTimeout(() => { btn.style.background = ''; btn.style.color = ''; }, 1200);
        console.log(`✓ Auto-Crop: ${img.width}×${img.height} → ${canvas.width}×${canvas.height}`);
      };
      img.src = IMG_DATAURL;
    });
    console.log('✓ Auto-Crop module armed.');
  }, 800);
})();
