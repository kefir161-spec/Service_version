// === Color pipeline utilities ======================================
(function(){
  // Convert sRGB hex (#RRGGBB) to THREE.Color in *linear* space (for r128)
  function srgbComponentToLinear(c){
    c = c/255;
    return (c <= 0.04045) ? (c/12.92) : Math.pow((c+0.055)/1.055, 2.4);
  }
  window.srgbColor = function(hex){
    // hex may be like '#6B7280' or 0xRRGGBB
    var h = (typeof hex === 'number') ? hex.toString(16).padStart(6,'0') :
            (hex.charAt(0)==='#' ? hex.slice(1) : hex);
    var r = parseInt(h.slice(0,2),16);
    var g = parseInt(h.slice(2,4),16);
    var b = parseInt(h.slice(4,6),16);
    return new THREE.Color(
      srgbComponentToLinear(r),
      srgbComponentToLinear(g),
      srgbComponentToLinear(b)
    );
  };

  window.setupColorPipeline = function(renderer){
    if(!renderer) return;

    // Prefer modern colorSpace API (r150+). Fallback to outputEncoding for older builds.
    if (renderer.outputColorSpace !== undefined && THREE.SRGBColorSpace !== undefined) {
      renderer.outputColorSpace = THREE.SRGBColorSpace;
    } else if (renderer.outputEncoding !== undefined && THREE.sRGBEncoding !== undefined) {
      renderer.outputEncoding = THREE.sRGBEncoding;
    }

    renderer.toneMapping = THREE.NoToneMapping;
    renderer.toneMappingExposure = 1.0;
  };

  window.applyBaseColors = function(scene, floorMesh, wallMeshes, colors){
    colors = colors || { floor:'#5B676D', wall:'#8E969D', sky:'#8E969D' };
    if(scene){
      scene.background = srgbColor(colors.sky);
    }
    if(floorMesh && floorMesh.material){
      floorMesh.material.color.copy( srgbColor(colors.floor) );
      floorMesh.material.roughness = 1; floorMesh.material.metalness = 0;
      floorMesh.material.needsUpdate = true;
    }
    if(Array.isArray(wallMeshes)){
      wallMeshes.forEach(function(w){
        if(w && w.material){
          w.material.color.copy( srgbColor(colors.wall) );
          w.material.roughness = 1; w.material.metalness = 0;
          w.material.needsUpdate = true;
        }
      });
    }
  };
})();
// === End color pipeline utilities ==================================

;

/*
 Main app script:
 - Scene setup (Three.js)
 - Block placement / delete
 - Ghost preview
 - Editor (face select / recolor / replace)
 - Undo / Redo
 - Camera keyboard controls (WASD / E / F / Q / R)
 - Stats and GLB export
*/
(function(){
  // ===== Utilities =====
  function el(id){ return document.getElementById(id); }

// === Global loader helpers ===
var loaderStartTime = 0;
var loaderMinDuration = 3000; // минимум 3 секунды при старте
var loaderStartupPhase = false;

var loaderDefaultText =
  (window.CubikI18N && window.CubikI18N.t)
    ? window.CubikI18N.t('loader.loading')
    : 'Loading Cubiks...';

function setLoaderLabel(text){
  var root = document.getElementById('globalLoader');
  if(!root) return;
  var label = root.querySelector('.loader-label');
  if(label && text){ label.textContent = text; }
}

function showLoader(text){
  var root = document.getElementById('globalLoader');
  if(!root) return;

  if(!text) text = loaderDefaultText;
  if(text){ setLoaderLabel(text); }

  // стартовую фазу фиксируем только при первом показе
  if(!loaderStartupPhase){
    loaderStartupPhase = true;
    loaderStartTime = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  }
  root.style.display = 'flex';
}

function hideLoaderImmediate(){
  var root = document.getElementById('globalLoader');
  if(!root) return;
  root.style.display = 'none';
}

// обычное скрытие без минимального времени
function hideLoader(){
  loaderStartupPhase = false;
  hideLoaderImmediate();
}

function hideLoaderWithStartupMin(){
  if(!loaderStartupPhase){
    hideLoaderImmediate();
    return;
  }
  var now = (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
  var elapsed = now - loaderStartTime;
  if(elapsed >= loaderMinDuration){
    loaderStartupPhase = false;
    hideLoaderImmediate();
  }else{
    var remain = loaderMinDuration - elapsed;
    setTimeout(function(){
      loaderStartupPhase = false;
      hideLoaderImmediate();
    }, remain);
  }
}

  function hexToDec(h){ return parseInt(String(h).replace('#',''),16); }
  function hexNorm(hex){
    var s=String(hex||'').trim();
    if(s.charAt(0)!=='#'){ s='#'+s; }
    if(s.length===4){
      var r=s.charAt(1),g=s.charAt(2),b=s.charAt(3);
      s='#'+r+r+g+g+b+b;
    }
    return s.toUpperCase();
  }
  function toLinear(hex){
    var c=new THREE.Color(hex);
    if(c.convertSRGBToLinear) c.convertSRGBToLinear();
    return c;
  }
  function computeOverlay(){ return 0x22c55e; }

  // ===== Palette (RAL) =====
  var RALS=[
    ["RAL 7037","#7D7F7D"],        // grey (Zen/2 grey)
    ["Bion beige","#E1B589"],      // slightly darker/muted beige for previews
    ["Bion green","#0A6F3C"],      // slightly darker green for previews
    ["RAL 9003","#F4F4F4"],        // white
    ["RAL 9005","#0A0A0A"]         // black
  ];
  var RAL_REV=(function(){
    var m={};
    for(var i=0;i<RALS.length;i++){
      m[hexNorm(RALS[i][1])] = RALS[i][0];
    }
    return m;
  })();

  
// --- Wrapper collider system (injected) ---
var wrappers = [];           // invisible wrapper meshes (raycast targets)
var snapTargets = [];        // what we raycast for snapping: wrappers + ground

function getWrapperMaterial(){
  try{
    var m = new THREE.MeshBasicMaterial({ transparent:true, opacity:0.0 });
    m.depthWrite = false;
    m.colorWrite = false; // do not render, but remain raycastable
    m.side = THREE.DoubleSide;
    return m;
  }catch(e){ return new THREE.MeshBasicMaterial({ visible:false }); }
}

function createWrapperForBlock(owner){
  try{
    if(!owner) return null;
    var eps = 0.002; // thin shell to stabilize hits at shared faces
    
    var kind = owner.userData?.kind;
    var hh = getHalf(kind);
    
    var w = new THREE.Mesh(new THREE.BoxGeometry(1+eps,1+eps,1+eps), getWrapperMaterial());
    w.name = 'wrapper';
    w.userData.wrapperOwner = owner;
    
    // Всегда устанавливаем размер на основе getHalf для точного соответствия bounding box
    w.scale.set(hh.x*2+eps, hh.y*2+eps, hh.z*2+eps);
    
    // Keep as a separate object at scene root to avoid polluting owner's bounding box
    scene.add(w);
    wrappers.push(w);
    updateSnapTargets();
    return w;
  }catch(e){ return null; }
}

function removeWrapperForBlock(owner){
  for (var i=wrappers.length-1;i>=0;i--){
    var w=wrappers[i];
    if(w.userData && w.userData.wrapperOwner===owner){
      try{ scene.remove(w); }catch(e){}
      try{
        if(w.geometry && w.geometry.dispose) w.geometry.dispose();
        if(w.material && w.material.dispose) w.material.dispose();
      }catch(e){}
      wrappers.splice(i,1);
    }
  }
  updateSnapTargets();
}

function clearAllWrappers(){
  for (var i=0;i<wrappers.length;i++){
    var w=wrappers[i];
    try{ scene.remove(w); }catch(e){}
    try{
      if(w.geometry && w.geometry.dispose) w.geometry.dispose();
      if(w.material && w.material.dispose) w.material.dispose();
    }catch(e){}
  }
  wrappers.length = 0;
  updateSnapTargets();
}

function updateSnapTargets(){
  if (Array.isArray(wrappers)){
    snapTargets = wrappers.slice();
  } else {
    snapTargets = [];
  }
  if (typeof ground !== 'undefined' && ground) snapTargets.push(ground);
}

// Keep wrappers following their owners
function __syncWrappers(){
  for (var i=0;i<wrappers.length;i++){
    var w = wrappers[i];
    var o = w.userData && w.userData.wrapperOwner;
    if(!o) continue;
    
    try{
      w.position.copy(o.position);
      w.quaternion.copy(o.quaternion);
      
      var kind = (o.userData && o.userData.kind) ? o.userData.kind : null;
      var hh = getHalf(kind);
      
      // Всегда используем getHalf для точного размера
      w.scale.set(hh.x*2 + 0.002, hh.y*2 + 0.002, hh.z*2 + 0.002);
    }catch(e){
      // Fallback - копируем масштаб владельца
      try{ w.scale.copy(o.scale); }catch(_){}
    }
  }
}

// Create a non-pickable wrapper around ghost (optional, helps visualize/debug, not used for raycast)
function attachGhostWrapper(g){
  try{
    if(!g) return;
    if (g.userData && g.userData._wrapperGhost) { return; }
    var eps = 0.002;
    var w = new THREE.Mesh(new THREE.BoxGeometry(1+eps,1+eps,1+eps), getWrapperMaterial());
    w.name = 'ghostWrapper';
    // Do not add to wrappers/snapTargets to avoid self-hits
    g.add(w);
    g.userData._wrapperGhost = w;
  }catch(e){}
}
// ===== Globals =====
  var scene,camera,renderer,controls,raycaster,mouse,ground,bgScene,bgCamera,bgMesh;
  var objects=[], pickables=[], ghost=null, ghostType='Void';
  var baseGeom={"Void":null,"Zen":null,"Bion":null,"Zen/2":null};
  var faceGeoms={};
  // === Prefabs registry ===
  var customKinds = {};
  var KIND_AUTO = 1;
  function isCustomKind(k){ return !!customKinds[k]; }
  function isZen2LikeKind(kind){
    if (kind === 'Zen/2') return true;
    if (!kind) return false;
    var data = customKinds && customKinds[kind];
    return !!(data && data.zen2Like);
  }
  var currentColor=0x0A6F3C, currentColorHex='#0A6F3C'; // Bion green by default
  var editorFaceHex = null; // independent face color for editor

  var selectedBlock=null; try{ window.selectedBlock = selectedBlock; }catch(e){}
  try{ window.getSelectedBlock = function(){ return selectedBlock; }; }catch(e){}
  var selectedFaces={top:false,bottom:false,front:false,back:false,left:false,right:false};

  var isPointerDown=false, pointerDownPos={x:0,y:0}, lastCursor={x:0,y:0};
  var isRightButtonDown=false, rightClickDownPos={x:0,y:0}, rightClickDownTime=0;


  // === Ghost debug & kind alias ===
  var DEBUG_GHOST = false;
  var GHOST_KIND_NAME = 'FromEdited';
  function dbgGhost(){
    if(!DEBUG_GHOST) return;
    try{
      var args = Array.prototype.slice.call(arguments);
      args.unshift('[GHOST]');
      console.log.apply(console, args);
    }catch(e){}
  }


  var previewScene=null,previewCamera=null,previewRenderer=null,previewControls=null;
  var previewRoot=null,previewRaycaster=null,previewMouse=null,previewOutline=null;
  var previewTicker=false, hoverSuppressUntil=0;

  // undo/redo stacks
  var undoStack = [], redoStack = [];
  var MAX_UNDO_STEPS = 600;
  var hasUnsavedChanges = false;

  // Timelapse replay and video recording
  var isReplayingBuild = false;
  var replayTimer = null;
  var mediaRecorder = null;
  var recordedChunks = [];
  // keyboard movement state
  var keyState={ w:false,a:false,s:false,d:false,e:false,f:false,q:false,r:false };

  // camera orbit pivot (for Q/R rotation)
  var lastPlacedCenter = new THREE.Vector3(0, 0.5, 0);

  // ===== Gallery scenes =====
  var galleryScenes = {};

// Zen/2 orientation state for preview + ghost
  // 0 = default, 1 = rotated 90deg around X, 2 = rotated 90deg around Z
  var zen2OrientationIndex = 0;
  var zen2HalfCache = {};

  function applyZen2Orientation(mesh){
    if(!mesh) return;
    // Keep current Y rotation (for spinning preview), only change X/Z
    var ry = (mesh.rotation && mesh.rotation.y) || 0;
    if(zen2OrientationIndex === 1){
      mesh.rotation.set(Math.PI/2, ry, 0);
    } else if(zen2OrientationIndex === 2){
      mesh.rotation.set(0, ry, Math.PI/2);
    } else {
      mesh.rotation.set(0, ry, 0);
    }
  }

  // ===== Face type selection =====
  var selectedFaceType = 'Void';
  var faceTypeScenes = {};

  // ===== Face selection helpers =====
  function clearSelected(){
    selectedFaces.top=false;
    selectedFaces.bottom=false;
    selectedFaces.front=false;
    selectedFaces.back=false;
    selectedFaces.left=false;
    selectedFaces.right=false;
  }
  function selectedList(){
    var arr=[];
    for(var k in selectedFaces){
      if(selectedFaces[k]) arr.push(k);
    }
    return arr;
  }

  function msg(text, ok){
    var s=el('status');
    if(s){
      s.textContent=text;
      s.style.color = ok!==false ? 'var(--green)' : 'var(--red)';
    }
  }

  function setRAL(hex){
    currentColor=hexToDec(hex);
    currentColorHex=hex;

    var sw=el('sw');
    if(sw) sw.style.background=hex;

    var rr=el('ralSelect');
    if(rr) rr.value=hex;

    var fr=el('faceColor');
    if(fr) fr.value=hex;

    // Обновляем цвет превью кубов в галерее
    updateGalleryColors(hex);
  }

  // ===== Обновление цветов превью кубов =====
  function updateGalleryColors(colorHex){
    for(var kind in galleryScenes){
      if(galleryScenes.hasOwnProperty(kind)){
        var sceneData = galleryScenes[kind];
        if(sceneData && sceneData.mesh && sceneData.mesh.material){
          sceneData.mesh.material.color.set(toLinear(colorHex));
        }
      }
    }
  }

  // ===== Управление призрачным кубом =====
  function hideGhost(){
    if(ghost){
      ghost.visible = false;
    }
  }


  // Update ghost position/validity based on last cursor
  function updateGhost(){
    if(!ghost) return;
    try{
      var rect = renderer.domElement.getBoundingClientRect();
      var x = lastCursor.x || (rect.left + rect.width/2);
      var y = lastCursor.y || (rect.top + rect.height/2);
      onMove({clientX:x, clientY:y});
    }catch(e){
      dbgGhost('updateGhost error', e);
    }
  }

  function showGhost(){
    if(ghost){
      ghost.visible = true;
      updateGhost();
    }
  }

  // ===== Face geometry extraction =====
  function makeBoxFacesFromGeometry(geom){
    if(!geom||typeof geom.clone!=="function"){
      geom=new THREE.BoxGeometry(1,1,1);
    }
    var g=geom.clone();
    g.computeBoundingBox();
    var bb=g.boundingBox;
    var min=bb.min, max=bb.max;

    var pos=g.attributes.position.array;
    var idx=g.index?g.index.array:null;

    var faces={top:null,bottom:null,front:null,back:null,left:null,right:null};

    var EPS=1e-6;
    var ex=max.x-min.x, ey=max.y-min.y, ez=max.z-min.z;
    var tol=Math.max(ex,ey,ez)*0.03 + EPS;

    function addTri(out, ia, ib, ic){
      out.push(
        pos[ia*3],pos[ia*3+1],pos[ia*3+2],
        pos[ib*3],pos[ib*3+1],pos[ib*3+2],
        pos[ic*3],pos[ic*3+1],pos[ic*3+2]
      );
    }

    function extract(axis,isMax){
      var verts=[];
      var N=idx?idx.length/3:pos.length/9;
      for(var i=0;i<N;i++){
        var ia=idx?idx[i*3]:i*3;
        var ib=idx?idx[i*3+1]:i*3+1;
        var ic=idx?idx[i*3+2]:i*3+2;
        var a={x:pos[ia*3], y:pos[ia*3+1], z:pos[ia*3+2]};
        var b={x:pos[ib*3], y:pos[ib*3+1], z:pos[ib*3+2]};
        var c={x:pos[ic*3], y:pos[ic*3+1], z:pos[ic*3+2]};

        var plane=isMax?max[axis]:min[axis];

        if(Math.abs(a[axis]-plane)<tol &&
           Math.abs(b[axis]-plane)<tol &&
           Math.abs(c[axis]-plane)<tol){
          addTri(verts, ia, ib, ic);
        }
      }
      if(verts.length===0) return null;
      var out=new THREE.BufferGeometry();
      out.setAttribute('position', new THREE.Float32BufferAttribute(verts,3));
      out.computeVertexNormals();
      return out;
    }

    faces.top=extract('y',true);
    faces.bottom=extract('y',false);
    faces.front=extract('z',true);
    faces.back=extract('z',false);
    faces.right=extract('x',true);
    faces.left=extract('x',false);

    // fill any missing faces with thin quads
    if(!faces.top || !faces.bottom || !faces.front || !faces.back || !faces.right || !faces.left){
      var cx=(min.x+max.x)/2,
          cy=(min.y+max.y)/2,
          cz=(min.z+max.z)/2;
      var thin=Math.max(Math.min(ex,ey,ez)*0.002, 0.0002);

      if(!faces.top){
        var gtop=new THREE.BoxGeometry(ex, thin, ez);
        gtop.translate(cx, max.y-thin/2, cz);
        faces.top=gtop;
      }
      if(!faces.bottom){
        var gb=new THREE.BoxGeometry(ex, thin, ez);
        gb.translate(cx, min.y+thin/2, cz);
        faces.bottom=gb;
      }
      if(!faces.front){
        var gf=new THREE.BoxGeometry(ex, ey, thin);
        gf.translate(cx, cy, max.z-thin/2);
        faces.front=gf;
      }
      if(!faces.back){
        var gk=new THREE.BoxGeometry(ex, ey, thin);
        gk.translate(cx, cy, min.z+thin/2);
        faces.back=gk;
      }
      if(!faces.right){
        var gr=new THREE.BoxGeometry(thin, ey, ez);
        gr.translate(max.x-thin/2, cy, cz);
        faces.right=gr;
      }
      if(!faces.left){
        var gl=new THREE.BoxGeometry(thin, ey, ez);
        gl.translate(min.x+thin/2, cy, cz);
        faces.left=gl;
      }
    }

    return faces;
  }

  function axisForFace(dir){
    var d=(dir||'').toLowerCase();
    if(d==='top') return {axis:'y',isMax:true};
    if(d==='bottom') return {axis:'y',isMax:false};
    if(d==='front') return {axis:'z',isMax:true};
    if(d==='back') return {axis:'z',isMax:false};
    if(d==='right') return {axis:'x',isMax:true};
    if(d==='left') return {axis:'x',isMax:false};
    return {axis:'y',isMax:true};
  }

  function alignGeomPlaneTo(oldGeom,newGeom,dir){
    var a=axisForFace(dir);
    var axis=a.axis, isMax=a.isMax;

    var og=oldGeom.clone(); og.computeBoundingBox();
    var ng=newGeom.clone(); ng.computeBoundingBox();

    var oBB=og.boundingBox, nBB=ng.boundingBox;
    var oPlane=isMax?oBB.max[axis]:oBB.min[axis];
    var nPlane=isMax?nBB.max[axis]:nBB.min[axis];
    var delta=oPlane-nPlane;

    var t=new THREE.Vector3(0,0,0);
    t[axis]=delta;
    ng.translate(t.x,t.y,t.z);

    ng.computeBoundingBox();
    ng.computeVertexNormals();
    return ng;
  }

  // Extract per-face metadata (colors, types, geometries in group space)
  function faceMetaFromBlock(blk){
    var colors={}, types={}, geoms={}, dirs=['top','bottom','front','back','left','right'];
    for(var i=0;i<dirs.length;i++){
      var dir=dirs[i], f=blk.userData.faces[dir];
      if(!f) continue;
      var hex = '#7D7F7D';
      try{
        if(f.material && f.material.userData && f.material.userData.baseHex) hex = f.material.userData.baseHex;
        else if(f.material && f.material.color) hex = '#'+f.material.color.getHexString();
      }catch(e){}
      colors[dir]=hex;
      types[dir] = (blk.userData.faceTypes && blk.userData.faceTypes[dir]) || blk.userData.kind || 'Void';
      var g = f.geometry.clone();
      var mtx=new THREE.Matrix4().compose(
        f.position.clone(),
        new THREE.Quaternion().setFromEuler(f.rotation.clone()),
        f.scale.clone()
      );
      g.applyMatrix4(mtx);
      geoms[dir]=g;
    }
    return { colors:colors, types:types, geoms:geoms };
  }

  // Register a new prefab/custom kind from edited block
  function registerCustomKindFromBlock(blk, name){
    var merged = mergedGeomFromBlock(blk);
    if(!merged) return null;
    var meta = faceMetaFromBlock(blk);

    // Генерируем уникальное имя вида, чтобы не перетирать предыдущие
    var kind;
    if (name){
      var base = String(name);
      var candidate = base;
      var idx = 1;
      // Не даём перезаписать уже существующий kind
      while ((baseGeom[candidate] || customKinds[candidate]) && idx < 10000){
        candidate = base + '_' + String(idx++);
      }
      kind = candidate;
    } else {
      kind = 'Kind-' + String(KIND_AUTO++).padStart(3,'0');
    }

    // Для solid-куба используем слитую геометрию,
    // а для по-гранной версии — точные геометрии граней из meta.geoms
    baseGeom[kind] = merged;
    faceGeoms[kind] = meta.geoms || makeBoxFacesFromGeometry(merged);

    // Determine if this kind should behave like Zen/2 for snapping/orientation
    var zen2Like = false;
    try{
      if (blk && blk.userData){
        var srcKind = blk.userData.kind;
        if (srcKind === 'Zen/2'){
          zen2Like = true;
        } else if (customKinds && customKinds[srcKind] && customKinds[srcKind].zen2Like){
          zen2Like = true;
        }
      }
    }catch(e){}

    customKinds[kind] = {
      mergedGeom: merged,
      faceGeoms: meta.geoms,
      faceColors: meta.colors,
      faceTypes: meta.types,
      zen2Like: zen2Like
    };
    dbgGhost && dbgGhost('registered kind', { kind:kind, zen2Like:zen2Like });
    return kind;
  }

  try{ window.registerCustomKindFromBlock = registerCustomKindFromBlock; window.buildGroupFromCustomKind = buildGroupFromCustomKind; window.faceMetaFromBlock = faceMetaFromBlock; }catch(e){}

  // Build an editable group (6 faces) from a custom kind
  function buildGroupFromCustomKind(kind){
    var data = customKinds[kind];
    if(!data) return null;
    var group=new THREE.Group();
    group.userData={ kind:kind, isBlock:true, solid:false, faces:{}, faceTypes:{} };
    var dirs=['top','bottom','front','back','left','right'];
    for(var i=0;i<dirs.length;i++){
      var dir=dirs[i];
      var geom = data.faceGeoms[dir];
      if(!geom) continue;
      var hex = data.faceColors[dir] || '#7D7F7D';
      var mat = createMat(hex);
      try{ mat.userData={ baseHex:hex }; }catch(e){}
      var m=new THREE.Mesh(geom.clone(), mat);
      m.castShadow=true;
      m.name='face_'+dir;
      m.userData={ isFace:true, faceDir:dir };
      group.add(m);
      group.userData.faces[dir]=m;
      group.userData.faceTypes[dir] = data.faceTypes[dir] || kind;
      pickables.push(m);
    }
    return group;
  }
  // Build merged geometry from faces of an editable block (group)
  function mergedGeomFromBlock(blk){
    if(!blk || !blk.userData || !blk.userData.faces){
      dbgGhost('mergedGeomFromBlock: no faces on block', blk);
      return null;
    }
    var parts=[];
    var dirs=['top','bottom','front','back','left','right'];
    for(var i=0;i<dirs.length;i++){
      var dir=dirs[i];
      var f=blk.userData.faces[dir];
      if(!f || !f.geometry) continue;
      var g=f.geometry.clone();
      var mtx=new THREE.Matrix4();
      mtx.compose(
        f.position.clone(),
        new THREE.Quaternion().setFromEuler(f.rotation.clone()),
        f.scale.clone()
      );
      g.applyMatrix4(mtx);
      parts.push(g);
    }
    if(parts.length===0){
      dbgGhost('mergedGeomFromBlock: no geometry parts collected');
      return null;
    }
    try{
      var merged=THREE.BufferGeometryUtils.mergeBufferGeometries(parts, true);
      merged.computeBoundingBox();
      merged.computeVertexNormals();
      return merged;
    }catch(e){
      dbgGhost('mergeBufferGeometries failed:', e);
      return null;
    }
  }

  // Adopt ghost geometry from the last edited block
  function adoptGhostFromEdited(blk){
    try{
      if(!blk){
        dbgGhost('adoptGhostFromEdited: no block');
        return false;
      }

      var kindName = GHOST_KIND_NAME;

      // Prefer full custom-kind registration to preserve per-face colors and geometry
      if (typeof registerCustomKindFromBlock === 'function'){
        var k = registerCustomKindFromBlock(blk, GHOST_KIND_NAME);
        if (k) kindName = k;
      } else {
        // Fallback: only merged geometry, like old behaviour
        var g = mergedGeomFromBlock(blk);
        if(!g){
          dbgGhost('adoptGhostFromEdited: merged geometry unavailable, keeping previous ghost.');
          return false;
        }
        baseGeom[kindName] = g;
        faceGeoms[kindName] = makeBoxFacesFromGeometry(g);
      }

      ghostType = kindName;

      // Update ghost using the same path as other UI controls
      if (typeof setGhostType === 'function'){
        setGhostType(kindName);
      } else if (typeof makeGhost === 'function'){
        makeGhost(kindName);
      }

      var g2 = baseGeom[kindName];
      if (g2 && g2.computeBoundingBox){
        g2.computeBoundingBox();
        var bb = g2.boundingBox;
        var size = new THREE.Vector3();
        bb.getSize(size);
        var half = size.clone().multiplyScalar(0.5);
        dbgGhost('adopted', {
          kind: kindName,
          size: [size.x,size.y,size.z],
          half: [half.x,half.y,half.z]
        });
      }

      return true;
    }catch(e){
      dbgGhost('adoptGhostFromEdited error:', e);
      return false;
    }
  }

  // expose helpers globally
  try{ window.mergedGeomFromBlock = mergedGeomFromBlock; window.adoptGhostFromEdited = adoptGhostFromEdited; }catch(e){}

  // ===== Scene / setup =====
  function setupScene(){
    scene=new THREE.Scene();

    // Fullscreen radial gradient background in a separate scene
    bgScene = new THREE.Scene();
    bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    (function(){
      var inner = srgbColor('#E9EDF5'); // bottom (near horizon)
      var outer = srgbColor('#111827'); // top / corners

      var bgMaterial = new THREE.ShaderMaterial({
        uniforms: {
          colorInner: { value: inner },
          colorOuter: { value: outer }
        },
        vertexShader: [
          'varying vec2 vUv;',
          'void main(){',
          '  vUv = uv;',
          '  gl_Position = vec4(position.xy, 0.0, 1.0);',
          '}'
        ].join('\n'),
        fragmentShader: [
          'varying vec2 vUv;',
          'uniform vec3 colorInner;',
          'uniform vec3 colorOuter;',
          'void main(){',
          '  float t = smoothstep(0.0, 1.0, vUv.y);',
          '  vec3 col = mix(colorInner, colorOuter, t);',
          '  gl_FragColor = vec4(col, 1.0);',
          '}'
        ].join('\n'),
        depthTest: false,
        depthWrite: false
      });

      bgMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMaterial);
      bgMesh.frustumCulled = false;
      bgScene.add(bgMesh);
    })();

    // The main 3D scene itself has no background color; gradient quad covers the frame
    scene.background = null;

    camera=new THREE.PerspectiveCamera(
      60,
      window.innerWidth/window.innerHeight,
      0.1,
      300
    );
    camera.position.set(6,4.2,6);

    
renderer=new THREE.WebGLRenderer({antialias:true});
    renderer.autoClear = false;
    
    
    
try{ renderer.setPixelRatio(Math.min(window.devicePixelRatio||1, 1.5)); }catch(_){}

try{
  var _dom = renderer.domElement;
  _dom.addEventListener('webglcontextlost', function(e){ e.preventDefault(); console.warn('WebGL context lost'); });
  _dom.addEventListener('webglcontextrestored', function(){ try{ renderer.info.reset(); }catch(_){ } });
}catch(_){}
setupColorPipeline(renderer);
    renderer.setClearColor( srgbColor('#8B95A7'), 1 );
    renderer.setSize(window.innerWidth,window.innerHeight);
    renderer.shadowMap.enabled=true;
    renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    document.body.appendChild(renderer.domElement);

    // --- Lights (studio-style warm key + cool rim + hemi fill) ---
    // soft fill from above/below
    var hemiLight = new THREE.HemisphereLight(
      0xbfd7ff, // cool sky
      0x2a1a10, // warm ground bounce
      0
    );
    /* hemi light disabled */
    scene.add(new THREE.AmbientLight(0xffffff, 0.02));

    // warm key light with shadows
    var keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(8,14,6);
    keyLight.castShadow=true;
    keyLight.shadow.mapSize.width  = 1024;
    keyLight.shadow.mapSize.height = 1024;
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.radius = 24;
    keyLight.shadow.camera.far  = 80;
    keyLight.shadow.camera.left   = -20;
    keyLight.shadow.camera.right  =  20;
    keyLight.shadow.camera.top    =  20;
    keyLight.shadow.camera.bottom = -20;
    keyLight.shadow.normalBias = 0.015;
    scene.add(keyLight);

    // cool rim/back light, no shadows
    var rimLight = new THREE.DirectionalLight(0xffffff, 0.65);
    rimLight.position.set(-6,6,-10);
    rimLight.castShadow=false;
    scene.add(rimLight);

    // === Floor & walls from Cubik Build 1.0 ===
var plateSize=26*0.8;

    var floorMat=new THREE.MeshLambertMaterial({ color:0x5B676D });
    floorMat.color.copy( srgbColor('#5B676D') );;
    var floor=new THREE.Mesh(
      new THREE.PlaneGeometry(plateSize,plateSize),
      floorMat
    );
    floor.rotation.x=-Math.PI/2;
    floor.position.y=0;
    floor.receiveShadow=true;
    floor.name='floor';
    scene.add(floor);
    ground=floor;

    // glowing border around floor
    var edgeGeo=new THREE.EdgesGeometry(new THREE.PlaneGeometry(plateSize, plateSize));
    var edgeMat=new THREE.LineBasicMaterial({
      color:0x00eaff,
      transparent:true,
      opacity:0.5
    });
    var border=new THREE.LineSegments(edgeGeo,edgeMat);
    border.rotation.x=-Math.PI/2;
    border.position.y=0.002;
    scene.add(border);

    // corner walls
    var wallH=plateSize*0.4125;
    var wallMat=new THREE.MeshLambertMaterial({ color:0x8E969D });
    wallMat.color.copy( srgbColor('#8E969D') );;

    var wallFront=new THREE.Mesh(
      new THREE.PlaneGeometry(plateSize, wallH),
      wallMat
    );
    wallFront.position.set(0, wallH/2, -plateSize/2);
    wallFront.receiveShadow=true;
    scene.add(wallFront);

    var wallLeft=new THREE.Mesh(
      new THREE.PlaneGeometry(plateSize, wallH),
      wallMat
    );
    wallLeft.position.set(-plateSize/2, wallH/2, 0);
    wallLeft.rotation.y=Math.PI/2;
    wallLeft.receiveShadow=true;
    scene.add(wallLeft);
    applyBaseColors(scene, floor, [wallFront, wallLeft], { floor:'#5B676D', wall:'#8E969D', sky:'#8E969D' });

    // bevels
    var bevelW=plateSize*0.015;
    var bevelMat=new THREE.MeshLambertMaterial({ color:0x8E969D });;

    var bevelCorner=new THREE.Mesh(
      new THREE.BoxGeometry(bevelW, wallH, bevelW),
      bevelMat
    );
    bevelCorner.position.set(
      -plateSize/2 + bevelW/2,
      wallH/2,
      -plateSize/2 + bevelW/2
    );
    bevelCorner.castShadow=true;
    bevelCorner.receiveShadow=true;
    scene.add(bevelCorner);

    var bevelFrontFloor=new THREE.Mesh(
      new THREE.BoxGeometry(plateSize, bevelW, bevelW),
      bevelMat
    );
    bevelFrontFloor.position.set(
      0,
      bevelW/2,
      -plateSize/2 + bevelW/2
    );
    bevelFrontFloor.castShadow=true;
    bevelFrontFloor.receiveShadow=true;
    scene.add(bevelFrontFloor);

    var bevelLeftFloor=new THREE.Mesh(
      new THREE.BoxGeometry(bevelW, bevelW, plateSize),
      bevelMat
    );
    bevelLeftFloor.position.set(
      -plateSize/2 + bevelW/2,
      bevelW/2,
      0
    );
    bevelLeftFloor.castShadow=true;
    bevelLeftFloor.receiveShadow=true;
    scene.add(bevelLeftFloor);

    // edge lines for walls
    var wEdgeMat=new THREE.LineBasicMaterial({
      color:0x0a1222,
      transparent:true,
      opacity:0.55
    });
    var w1e=new THREE.LineSegments(
      new THREE.EdgesGeometry(wallFront.geometry),
      wEdgeMat
    );
    w1e.position.copy(wallFront.position);
    scene.add(w1e);

    var w2e=new THREE.LineSegments(
      new THREE.EdgesGeometry(wallLeft.geometry),
      wEdgeMat
    );
    w2e.position.copy(wallLeft.position);
    w2e.rotation.y=Math.PI/2;
    scene.add(w2e);

// Core interaction helpers
    raycaster=new THREE.Raycaster();
    mouse=new THREE.Vector2();

    controls=new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping=false;
    // disable middle-button orbit so we can use MMB to pick faces
    if(controls.mouseButtons){
      controls.mouseButtons.MIDDLE = null;
    }

    // Limit zoom-out distance so scene always stays in view
    if(typeof plateSize === 'number'){
      if(controls.maxDistance !== undefined) controls.maxDistance = plateSize * 0.9;
    }


    // Pointer events
    renderer.domElement.addEventListener('pointermove', onMoveQueued);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('click', onLeftClick);
    renderer.domElement.addEventListener('contextmenu', onRightClick);

    // Middle button / Tab -> open editor on hovered block
    function openByMiddle(e){
      if(e.button!==1) return;
      e.preventDefault();
      var hit=rayAt(e.clientX,e.clientY,pickables,true);
      if(hit){
        selectBlock(rootOf(hit.object));
        openEditor();
        ensureEditableSelected();
      }
    }
    renderer.domElement.addEventListener('auxclick', openByMiddle, false);
    renderer.domElement.addEventListener('mouseup', openByMiddle, false);
    renderer.domElement.addEventListener('mousedown', function(e){
      if(e.button===1) e.preventDefault();
    }, false);

    // Resize
    window.addEventListener('resize', function(){
      camera.aspect=window.innerWidth/window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth,window.innerHeight);
    });

    // UI buttons
    var clearBtn=el('clearBtn');
    if(clearBtn){
      clearBtn.addEventListener('click', function(){
        clearAll();
        pushState();
        resetPivot();
      });
    }

    var undoBtn=el('undoBtn');
    if(undoBtn) undoBtn.addEventListener('click', undoAction);

    var redoBtn=el('redoBtn');
    if(redoBtn) redoBtn.addEventListener('click', redoAction);

    var replayBtn = el('replayBuildBtn');
    if (replayBtn){
      replayBtn.addEventListener('click', function(){
        startBuildReplay({ record:false });
      });
    }

    var recordBtn = el('recordTimelapseBtn');
    if (recordBtn){
      recordBtn.addEventListener('click', function(){
        startBuildReplay({ record:true });
      });
    }

    var fr=el('faceColor');
    if(fr){
      fr.addEventListener('change', function(ev){
        setRAL(ev.target.value);
      });
    }

    var rep=el('replaceBtn');
    if(rep){
      rep.addEventListener('click', function(){
        if(replaceFaces()){
          pushState();
        }
      });
    }

    var edOv=el('edOverlay');
    if(edOv){
      edOv.addEventListener('click', closeEditor);
    }


    // Copy block under cursor to ghost (Ctrl+C)
    function copyBlockFromCursor(){
      if(!scene || !renderer) return false;

      var rect = renderer.domElement.getBoundingClientRect();
      var x = (lastCursor && lastCursor.x) || (rect.left + rect.width/2);
      var y = (lastCursor && lastCursor.y) || (rect.top + rect.height/2);

      var arr = (pickables && pickables.length) ? pickables : objects;
      if(!arr || !arr.length) return false;

      var hit = rayAt(x, y, arr, true);
      var blk = hit && hit.object ? rootOf(hit.object) : null;

      if(!blk && selectedBlock) blk = selectedBlock;
      if(!blk && objects && objects.length) blk = objects[objects.length-1];
      if(!blk) return false;

      var sourceBlock = blk;

      // Если копируем Zen/2-подобный куб — синхронизируем глобальную ориентацию
      try{
        if (sourceBlock && sourceBlock.userData && isZen2LikeKind(sourceBlock.userData.kind)){
          var twoPi = Math.PI * 2;
          function normAngleLocal(a){
            a = a % twoPi;
            if (a < 0) a += twoPi;
            return a;
          }
          var rx = normAngleLocal(sourceBlock.rotation.x || 0);
          var rz = normAngleLocal(sourceBlock.rotation.z || 0);
          var eps = 0.01;
          var ori = 0;
          if (Math.abs(rx - Math.PI/2) < eps || Math.abs(rx - 3*Math.PI/2) < eps){
            ori = 1;
          } else if (Math.abs(rz - Math.PI/2) < eps || Math.abs(rz - 3*Math.PI/2) < eps){
            ori = 2;
          }
          zen2OrientationIndex = ori;
          zen2HalfCache = {};
        }
      }catch(e){}

      // Helper: основной цвет блока
      function getBlockMainColorHex(block){
        try{
          if(block.userData && block.userData.faces){
            var dirs=['top','front','right','left','back','bottom'];
            for(var i=0;i<dirs.length;i++){
              var f=block.userData.faces[dirs[i]];
              if(!f || !f.material) continue;
              if(f.material.userData && f.material.userData.baseHex){
                return f.material.userData.baseHex;
              }
              if(f.material.color){
                return '#'+f.material.color.getHexString();
              }
            }
          }
          if(block.material){
            if(block.material.userData && block.material.userData.baseHex){
              return block.material.userData.baseHex;
            }
            if(block.material.color){
              return '#'+block.material.color.getHexString();
            }
          }
        }catch(e){}
        return currentColorHex || '#7D7F7D';
      }

      var kindHex = getBlockMainColorHex(sourceBlock);

      // Если это обычный солидный куб — просто используем базовый kind
      if(sourceBlock.userData && sourceBlock.userData.solid){
        var baseKind = sourceBlock.userData.kind || ghostType || 'Zen';

        if(kindHex){
          currentColorHex = kindHex;
          if(typeof setRAL === 'function') setRAL(kindHex);
        }

        if(typeof setGhostType === 'function'){
          setGhostType(baseKind);
        }else{
          ghostType = baseKind;
          if(typeof makeGhost === 'function') makeGhost(baseKind);
        }

        if(typeof updateGhost === 'function') updateGhost();
        try{ console.log('[COPY] solid block copied as kind', baseKind, 'color', kindHex); }catch(_){}
        return true;
      }

      // Если это уже "редакторский" / составной блок — регаем кастомный kind
      var kindSource = sourceBlock;
      var kind = null;

      if(typeof registerCustomKindFromBlock === 'function' && kindSource){
        try{
          kind = registerCustomKindFromBlock(kindSource, null);
        }catch(e){
          try{ console.error('[COPY] registerCustomKindFromBlock failed', e); }catch(_){}
        }
      }

      if(kind && typeof setGhostType === 'function'){
        setGhostType(kind);
      }

      if(kindHex){
        currentColorHex = kindHex;
        if(typeof setRAL === 'function') setRAL(kindHex);
      }

      if(typeof updateGhost === 'function') updateGhost();
      try{ console.log('[COPY] complex block copied to ghost', kind); }catch(_){}
      return true;
    }

    // Keyboard controls / hotkeys
    window.addEventListener('keydown', function(e){
      if((e.ctrlKey||e.metaKey) && e.shiftKey && (e.key==='z' || e.key==='Z')){ e.preventDefault(); return; }

      var k = (e.key||'').toLowerCase();
      var isCtrl = e.ctrlKey || e.metaKey;

      // Ctrl+C -> copy block under cursor to ghost
      if(isCtrl && k==='c'){
        var t = e.target;
        var tag = t && t.tagName ? t.tagName.toLowerCase() : '';
        var isEditing = t && (t.isContentEditable || tag==='input' || tag==='textarea' || tag==='select');
        if(!isEditing){
          e.preventDefault();
          e.stopPropagation();
          if(typeof copyBlockFromCursor === 'function' && copyBlockFromCursor()){
            return;
          }
        }
      }

      if(e.code==='KeyW') keyState.w=true;
      if(e.code==='KeyA') keyState.a=true;
      if(e.code==='KeyS') keyState.s=true;
      if(e.code==='KeyD') keyState.d=true;
      if(e.code==='KeyE') keyState.e=true;
      if(e.code==='KeyF') keyState.f=true;
      if(e.code==='KeyQ') keyState.q=true;
      if(e.code==='KeyR') keyState.r=true;

      if(e.key==='Escape'){
        closeEditor();
      }
      if(e.key==='Tab'){
        e.preventDefault();
        var hit=rayAt(lastCursor.x,lastCursor.y,pickables,true);
        if(hit){
          selectBlock(rootOf(hit.object));
          openEditor();
          ensureEditableSelected();
        }
      }
      // Undo / Redo
      if((e.ctrlKey||e.metaKey) && (e.key==='z' || e.key==='Z')){
        e.preventDefault();
        undoAction();
      }
      if((e.ctrlKey||e.metaKey) && (e.key==='y' || e.key==='Y')){
        e.preventDefault();
        redoAction();
      }
    });

    window.addEventListener('keyup', function(e){
      if(e.code==='KeyW') keyState.w=false;
      if(e.code==='KeyA') keyState.a=false;
      if(e.code==='KeyS') keyState.s=false;
      if(e.code==='KeyD') keyState.d=false;
      if(e.code==='KeyE') keyState.e=false;
      if(e.code==='KeyF') keyState.f=false;
      if(e.code==='KeyQ') keyState.q=false;
      if(e.code==='KeyR') keyState.r=false;
    });
  }

  // reset pivot to origin-ish
  function resetPivot(){
    try{
      var h=getHalf('Void').y;
      lastPlacedCenter.set(0, h, 0);
    }catch(e){
      lastPlacedCenter.set(0, 0.5, 0);
    }
  }

  function rootOf(o){
    var x=o;
    while(x && x.parent && x.parent!==scene){
      if(x.userData && x.userData.isBlock) break;
      x=x.parent;
    }
    return x||o;
  }

  function rayAt(x,y,arr,recursive){
    var r=renderer.domElement.getBoundingClientRect();
    var v=new THREE.Vector2(
      ((x-r.left)/r.width)*2-1,
      -((y-r.top)/r.height)*2+1
    );
    raycaster.setFromCamera(v,camera);
    var list=arr||scene.children;
    var hits=raycaster.intersectObjects(list, !!recursive);
    return hits[0]||null;
  }

  function getHalf(kind){
    // Orientation-aware half extents for Zen/2-like kinds
    if (isZen2LikeKind(kind)){
      // Use cached value per (kind, orientation) pair if available
      var cacheKey = String(kind) + ':' + String(zen2OrientationIndex);
      if (zen2HalfCache && zen2HalfCache.hasOwnProperty(cacheKey)){
        return zen2HalfCache[cacheKey].clone();
      }
      var g0 = baseGeom[kind];
      if (!g0){
        return new THREE.Vector3(0.5,0.5,0.5);
      }
      if (!g0.boundingBox){
        g0.computeBoundingBox();
      }
      // Start from base bounding box and rotate a copy according to orientation
      var box = g0.boundingBox.clone();
      var m = new THREE.Matrix4();
      if (zen2OrientationIndex === 1){
        m.makeRotationX(Math.PI/2);
        box.applyMatrix4(m);
      } else if (zen2OrientationIndex === 2){
        m.makeRotationZ(Math.PI/2);
        box.applyMatrix4(m);
      }
      var size = new THREE.Vector3();
      box.getSize(size);
      var h0 = size.multiplyScalar(0.5);

      if (!zen2HalfCache) zen2HalfCache = {};
      zen2HalfCache[cacheKey] = h0.clone();
      return h0;
    }

    var g = baseGeom[kind];
    if(!g){
      return new THREE.Vector3(0.5,0.5,0.5);
    }

    // Принудительно вычисляем bounding box
    if (!g.boundingBox) {
      g.computeBoundingBox();
    }

    var s = new THREE.Vector3();
    g.boundingBox.getSize(s);
    return s.multiplyScalar(0.5);
  }

function aabb(kind,center){
    var h=getHalf(kind);
    return new THREE.Box3().setFromCenterAndSize(
      center,
      new THREE.Vector3(h.x*2,h.y*2,h.z*2)
    );
  }

  // collision / placement check
  
function canPlace(center, kind, ignore){
    var h = getHalf(kind);

    // Допуск для проверки пересечений - достаточно большой чтобы учесть
    // погрешности при стыковке грань-к-грани
    var EPS = Math.max(h.x, h.y, h.z) * 0.01; // 1% от размера блока

    // Не даём кубу заметно проваливаться ниже пола
    var bottomY = center.y - h.y;
    if (bottomY < -EPS){
      return false;
    }

    // Жёстко запрещаем ставить куб в позицию, где уже стоит другой куб
    // (центры совпадают в пределах малого допуска). Это отрубает кейс "куб в куб".
    var centerEps = Math.max(h.x, h.y, h.z) * 0.1; // 10% - достаточно для детекции "куб в кубе"
    for (var ci = 0; ci < objects.length; ci++){
      var co = objects[ci];
      if (!co || !co.userData) continue;
      if (ignore && (co === ignore || co.uuid === ignore.uuid)) continue;
      var cp = co.position;
      if (Math.abs(cp.x - center.x) < centerEps &&
          Math.abs(cp.y - center.y) < centerEps &&
          Math.abs(cp.z - center.z) < centerEps){
        return false;
      }
    }

    // Тестовый бокс для нового блока - немного уменьшаем чтобы
    // разрешить стыковку грань-к-грани без ложных срабатываний
    var shrink = EPS * 2;
    var sx = Math.max(h.x * 2 - shrink, 0.01);
    var sy = Math.max(h.y * 2 - shrink, 0.01);
    var sz = Math.max(h.z * 2 - shrink, 0.01);
    var test = new THREE.Box3().setFromCenterAndSize(
      center,
      new THREE.Vector3(sx, sy, sz)
    );

    for (var i = 0; i < objects.length; i++){
      var o = objects[i];
      if (!o || !o.userData) continue;
      
      if (ignore){
        // Всегда игнорируем сам объект, к которому стыкуемся.
        if (o === ignore || o.uuid === ignore.uuid) continue;

        // Для Zen/2-подобных колонн разрешаем стыковку к целой колонне
        if (typeof isZen2LikeKind === 'function' &&
            isZen2LikeKind(kind) &&
            o.userData && ignore.userData &&
            isZen2LikeKind(ignore.userData.kind)){
          var dxCol = Math.abs(o.position.x - ignore.position.x);
          var dzCol = Math.abs(o.position.z - ignore.position.z);
          if (dxCol < 1e-3 && dzCol < 1e-3){
            continue;
          }
        }
      }

      var okind = o.userData.kind;
      var ob;
      // Для Zen/2-подобных берём реальный AABB по текущему повороту,
      // для остальных — используем aabb по типу
      var useExactBox = isZen2LikeKind(okind);
      if (!useExactBox && o.scale){
        var scx = Math.abs(o.scale.x - 1);
        var scy = Math.abs(o.scale.y - 1);
        var scz = Math.abs(o.scale.z - 1);
        if (scx > 1e-6 || scy > 1e-6 || scz > 1e-6){
          useExactBox = true;
        }
      }
      
      if (useExactBox){
        ob = new THREE.Box3().setFromObject(o);
      } else {
        ob = aabb(okind, o.position);
      }
      
      // Также немного уменьшаем существующий бокс для допуска касания
      var obShrink = EPS;
      ob.min.x += obShrink;
      ob.min.y += obShrink;
      ob.min.z += obShrink;
      ob.max.x -= obShrink;
      ob.max.y -= obShrink;
      ob.max.z -= obShrink;

      // Проверяем реальное пересечение (не касание)
      var overlapX = test.max.x > ob.min.x && test.min.x < ob.max.x;
      var overlapY = test.max.y > ob.min.y && test.min.y < ob.max.y;
      var overlapZ = test.max.z > ob.min.z && test.min.z < ob.max.z;

      if (overlapX && overlapY && overlapZ){
        return false;
      }
    }
    return true;
  }

function snap(v, step){
    var eps = step * 1e-4;
    return Math.round((v + (v >= 0 ? eps : -eps)) / step) * step;
  }

  function getAxisSnapStep(axis, hv, kind){
    var st;
    if (typeof isZen2LikeKind === 'function' && isZen2LikeKind(kind)){
      if (zen2OrientationIndex === 1){
        if (axis === 'x'){
          st = 128;
        } else if (axis === 'y'){
          st = 225;
        } else {
          st = hv[axis] * 2;
        }
      } else if (zen2OrientationIndex === 2){
        if (axis === 'z'){
          st = 128;
        } else if (axis === 'y'){
          st = 225;
        } else {
          st = hv[axis] * 2;
        }
      } else {
        st = hv[axis] * 2;
      }
    } else {
      st = hv[axis] * 2;
    }
    return st;
  }


  // Pointer move = ghost follow
  function onMove(e){
    // Скрываем призрак если открыт редактор
    if(document.body.classList.contains('editor-open')){
      if(ghost && ghost.visible){
        ghost.visible = false;
      }
      return;
    }

    lastCursor.x=e.clientX;
    lastCursor.y=e.clientY;

    var r=renderer.domElement.getBoundingClientRect();
    mouse.x=((e.clientX-r.left)/r.width)*2-1;
    mouse.y=-((e.clientY-r.top)/r.height)*2+1;

    raycaster.setFromCamera(mouse,camera);
    var hits=raycaster.intersectObjects(snapTargets,true);

    if(!ghost){
      return;
    }
    if(!hits.length){
      ghost.visible=false;
      return;
    }
    var hit=hits[0];
    if(hit && hit.object && hit.object.userData && hit.object.userData.wrapperOwner){ hit.object = hit.object.userData.wrapperOwner; }

    var h=getHalf(ghostType);
    var pos=new THREE.Vector3();
    var ok=true;

    if(hit.object===ground){
      // Попали в пол. Но сначала проверим, нет ли над точкой пола куба,
      // от которого логичнее стыковаться (как в твоём кейсе под перемычкой).
      var hp = hit.point.clone();
      var support = null;
      var supportBox = null;
      var bestY = Infinity;
      var epsXZ = 1e-3;

      for(var si=0; si<objects.length; si++){
        var so = objects[si];
        if(!so || !so.userData) continue;
        var sk = so.userData.kind;
        var sbox;
        // Для Zen/2 используем setFromObject из-за ориентации,
        // для остальных - точный aabb на основе known half-extents
        if (typeof isZen2LikeKind === 'function' && isZen2LikeKind(sk)){
          sbox = new THREE.Box3().setFromObject(so);
        } else {
          sbox = aabb(sk, so.position);
        }
        if(hp.x >= sbox.min.x - epsXZ && hp.x <= sbox.max.x + epsXZ &&
           hp.z >= sbox.min.z - epsXZ && hp.z <= sbox.max.z + epsXZ &&
           sbox.min.y > hp.y + 1e-3){
          if(sbox.min.y < bestY){
            bestY = sbox.min.y;
            support = so;
            supportBox = sbox;
          }
        }
      }

      if(support && supportBox){
        // Проверяем, есть ли место между полом и support'ом для нового куба
        var spaceUnderSupport = supportBox.min.y;
        var newBlockHeight = h.y * 2;
        
        // Если места достаточно для куба на полу под support'ом
        if(spaceUnderSupport >= newBlockHeight - 0.01){
          // Ставим куб на пол, выравнивая по XZ с support'ом
          var axisU='x', axisV='z';

          function clampSnapLocal(val,axis,box,hv){
            var min=box.min[axis], max=box.max[axis];
            var half=hv[axis];

            var st = getAxisSnapStep(axis, hv, ghostType);

            var bottom=min+half, top=max-half;

            // Если блок больше доступного пролёта по этой оси — прижимаем к ближайшему краю.
            if(top < bottom){
              return (Math.abs(val - bottom) <= Math.abs(val - top)) ? bottom : top;
            }

            var nv = snap(val - bottom, st) + bottom;

            if(Math.abs(val-top) <= st*0.5) nv=top;
            if(Math.abs(val-bottom) <= st*0.5) nv=bottom;

            if(nv<bottom) nv=bottom;
            if(nv>top) nv=top;
            return nv;
          }

          pos.x = clampSnapLocal(hp.x,'x',supportBox,h);
          pos.z = clampSnapLocal(hp.z,'z',supportBox,h);
          // Ставим на пол (центр куба на высоте h.y)
          pos.y = h.y;

          ok = canPlace(pos, ghostType, support);
          if(ghost && ghost.userData){ ghost.userData.hitBlock = support; }
        } else {
          // Места нет - обычная логика пола
          var stx = h.x * 2;
          var stz = h.z * 2;
          pos.set(
            snap(hit.point.x, stx),
            h.y,
            snap(hit.point.z, stz)
          );
          ok = canPlace(pos, ghostType);
          if(ghost && ghost.userData){ ghost.userData.hitBlock = null; }
        }
      } else {
        // Обычная логика снапа по полу: на базовом уровне сетка не зависит от ориентации блока.
        var stx = h.x * 2;
        var stz = h.z * 2;
        pos.set(
          snap(hit.point.x, stx),
          h.y,
          snap(hit.point.z, stz)
        );
        ok = canPlace(pos, ghostType);
        if(ghost && ghost.userData){ ghost.userData.hitBlock = null; }
      }
    }else {      var blk=rootOf(hit.object);
      
      // Используем точный AABB на основе known half-extents вместо setFromObject,
      // который даёт неточные результаты для сложной геометрии
      var blkKind = (blk.userData && blk.userData.kind) ? blk.userData.kind : 'Void';
      var box;
      if (isZen2LikeKind(blkKind)) {
        // Для Zen/2 всё ещё используем setFromObject из-за ориентации
        box = new THREE.Box3().setFromObject(blk);
      } else {
        // Для остальных - используем точный aabb на основе half-extents
        box = aabb(blkKind, blk.position);
      }

      var n=hit.face.normal.clone()
        .transformDirection(hit.object.matrixWorld)
        .normalize();

      var axisN='y',axisU='x',axisV='z';
      if(Math.abs(n.x)>=Math.abs(n.y) && Math.abs(n.x)>=Math.abs(n.z)){
        axisN='x'; axisU='y'; axisV='z';
      } else if(Math.abs(n.z)>=Math.abs(n.x) && Math.abs(n.z)>=Math.abs(n.y)){
        axisN='z'; axisU='x'; axisV='y';
      }

      function clampSnap(val,axis,box,hv){
        var min=box.min[axis], max=box.max[axis];
        var half=hv[axis];

        var st;
        if (isZen2LikeKind(ghostType)){
          // Orientation-specific snapping for Zen/2
          if (zen2OrientationIndex === 1){
            // Rotated 90° around X:
            //  - right/left (world X) step = 128 mm
            //  - up (world Y) step = 225 mm
            if (axis === 'x'){
              st = 128;
            } else if (axis === 'y'){
              st = 225;
            } else {
              // other axis keeps default block-based step
              st = (axis==='y'? hv.y*2 : (axis==='x'? hv.x*2 : hv.z*2));
            }
          } else if (zen2OrientationIndex === 2){
            // Rotated 90° around Z:
            //  - forward/back (world Z) step = 128 mm
            //  - up (world Y) step = 225 mm
            if (axis === 'z'){
              st = 128;
            } else if (axis === 'y'){
              st = 225;
            } else {
              st = (axis==='y'? hv.y*2 : (axis==='x'? hv.x*2 : hv.z*2));
            }
          } else {
            // Orientation index 0 — keep previous behaviour as is
            st = (axis==='y'? hv.y*2 : (axis==='x'? hv.x*2 : hv.z*2));
          }
        } else {
          st = (axis==='y'? hv.y*2 : (axis==='x'? hv.x*2 : hv.z*2));
        }

        // Вычисляем допустимый диапазон для центра нового блока
        var bottom=min+half, top=max-half;

        // Если блок больше пролёта по этой оси, прижимаем к ближайшей границе
        if(top < bottom){
          return (Math.abs(val - bottom) <= Math.abs(val - top)) ? bottom : top;
        }

        // Привязываем к сетке относительно грани куба
        var nv = snap(val - bottom, st) + bottom;

        // Приоритет краям, если курсор близко к ним
        if(Math.abs(val-top) <= st*0.5) nv=top;
        if(Math.abs(val-bottom) <= st*0.5) nv=bottom;

        // Ограничиваем результат в допустимом диапазоне
        if(nv<bottom) nv=bottom;
        if(nv>top) nv=top;
        return nv;
      }

      // Вычисляем позицию по нормали (грань-к-грани)
      pos[axisN]=(n[axisN]>0
        ? box.max[axisN]+h[axisN]
        : box.min[axisN]-h[axisN]);

      // Вычисляем позицию по осям параллельным грани
      pos[axisU]=clampSnap(hit.point[axisU],axisU,box,h);
      pos[axisV]=clampSnap(hit.point[axisV],axisV,box,h);
      // При стыковке к Zen/2-подобным кубам даём приоритет выравниванию грань-к-грани,
      // а уже потом учитываем шаг. Особенно важно по вертикали (ось Y).
      if(blk && blk.userData && isZen2LikeKind(blk.userData.kind)){
        ['x','y','z'].forEach(function(ax){
          if(ax===axisU || ax===axisV){
            var val = hit.point[ax];
            var half = h[ax];
            var bottom = box.min[ax] + half;
            var top = box.max[ax] - half;

            if(ax === 'y'){
              // По вертикали всегда цепляемся к ближайшему краю (низ/верх),
              // чтобы куб легко стыковался с нижней/верхней кромкой колонки,
              // даже если курсор далеко от самой границы.
              var distBottom = Math.abs(val - bottom);
              var distTop = Math.abs(val - top);
              pos[ax] = (distBottom <= distTop) ? bottom : top;
            } else {
              // По остальным осям сохраняем прежнюю логику:
              // сначала шаг, но грань может перебить его, если ближе к клику.
              var snapped = pos[ax];
              var best = snapped;
              if(Math.abs(bottom - val) < Math.abs(best - val)) best = bottom;
              if(Math.abs(top - val) < Math.abs(best - val)) best = top;
              pos[ax] = best;
            }
          }
        });
      }


      ok=canPlace(pos,ghostType,blk);

      // Fallback removed: Zen/2 no longer snaps freely along face; only grid/edge snapping is used.

      if(ghost && ghost.userData){ ghost.userData.hitBlock = blk; }
    }

    ghost.position.copy(pos);
    ghost.userData.ok=ok;
    ghost.visible=true;
    ghost.material.color.set( ok?0x22c55e:0xef4444 );

    if(DEBUG_GHOST){
      if(!ghost.userData._dbg){ ghost.userData._dbg = { ok:null, hit:null }; }
      var hitType = (hit.object===ground) ? 'ground' : 'block';
      var dbg = ghost.userData._dbg;
      if(dbg.ok !== ok || dbg.hit !== hitType){
        dbgGhost('move', {hit: hitType, pos:[+pos.x.toFixed(3), +pos.y.toFixed(3), +pos.z.toFixed(3)], ok: ok});
        dbg.ok = ok; dbg.hit = hitType;
      }
    }
  }

  function onPointerDown(e){
    // Отслеживаем правую кнопку отдельно, чтобы отличать клик от драга
    if(e.button===2){
      isRightButtonDown=true;
      rightClickDownPos.x=e.clientX;
      rightClickDownPos.y=e.clientY;
      rightClickDownTime=(typeof performance!=='undefined' && performance.now)?performance.now():Date.now();
    }

    if(e.button!==0) return;
    isPointerDown=true;
    pointerDownPos.x=e.clientX;
    pointerDownPos.y=e.clientY;
  }

  function onPointerUp(e){
    if(e.button===2){
      isRightButtonDown=false;
    }
    if(e.button!==0) return;
    isPointerDown=false;
  }

  // Left click = place block if valid ghost
  function onLeftClick(e){
    // Не размещаем блоки если открыт редактор
    if(document.body.classList.contains('editor-open')){
      return;
    }

    if(e.button!==0) return;

    var dx=Math.abs(e.clientX-pointerDownPos.x);
    var dy=Math.abs(e.clientY-pointerDownPos.y);
    if(dx>5||dy>5) return;

    if(ghost && ghost.visible && ghost.userData.ok){
      var b = null;
      if(isCustomKind(ghostType)){
        b = buildGroupFromCustomKind(ghostType);
      } else {
        b = makeSolid(ghostType,currentColorHex);
      }
      if(!b) return;
      b.position.copy(ghost.position);
      // Всегда синхронизируем ориентацию с призраком (для Zen/2 и кастомных блоков)
      if(ghost){
        b.rotation.copy(ghost.rotation);
      }


      dbgGhost('place', {kind: ghostType, pos:[b.position.x,b.position.y,b.position.z]});
scene.add(b);
      objects.push(b);
      try{ createWrapperForBlock(b); }catch(e){}
      pickables.push(b);

      lastPlacedCenter.copy(b.position);

      updateCounter();
      msg('Cubik added', true);

      pushState();
    }
  }

  // Right click = delete block
  
// --- Safe GPU resource disposal for removed objects (injected) ---
function disposeObjectRecursive(obj){
  if(!obj) return;
  try{
    obj.traverse(function(n){
      try{
        if(n.isMesh){
          if(n.geometry && typeof n.geometry.dispose==='function'){ n.geometry.dispose(); }
          var mats = Array.isArray(n.material) ? n.material : [n.material];
          for(var i=0;i<mats.length;i++){
            var m=mats[i];
            if(m && m.isMaterial && typeof m.dispose==='function'){ m.dispose(); }
          }
        } else if(n.isLine){
          if(n.geometry && typeof n.geometry.dispose==='function'){ n.geometry.dispose(); }
          if(n.material && typeof n.material.dispose==='function'){ n.material.dispose(); }
        }
      }catch(e){ /* noop */ }
    });
  }catch(e){ /* noop */ }
}

function onRightClick(e){
  // Не удаляем блоки если открыт редактор
  if (document.body.classList.contains('editor-open')){
    e.preventDefault();
    return;
  }

  // Игнорируем правый клик, если это был драг (камера вращалась), а не точный клик
  // Сравниваем позицию при нажатии с позицией при contextmenu
  var dx = Math.abs(e.clientX - (rightClickDownPos && rightClickDownPos.x || 0));
  var dy = Math.abs(e.clientY - (rightClickDownPos && rightClickDownPos.y || 0));
  if (dx > 5 || dy > 5){
    // слишком большое смещение — считаем, что это был драг, не удаляем куб
    return;
  }

  e.preventDefault();

  var hit = null;

  // 1) Сначала пытаемся попасть по оболочкам, чтобы не простреливать полый блок насквозь
  try{
    if (Array.isArray(wrappers) && wrappers.length){
      hit = rayAt(e.clientX, e.clientY, wrappers, true);
    }
  }catch(_){}

  // 2) Если по оболочке не попали, тогда уже пробуем по реальным объектам
  if (!hit){
    hit = rayAt(e.clientX, e.clientY, objects, true);
  }
  if (!hit) return;

  var obj = hit.object;
  var b = null;

  // если попали по wrapper'у — берём его владельца
  if (obj && obj.userData && obj.userData.wrapperOwner){
    b = obj.userData.wrapperOwner;
  } else {
    b = rootOf(obj);
  }
  if (!b) return;

  // remove from scene + arrays
  try{ removeWrapperForBlock(b); }catch(e){}

  var tmp = [], i;
  for (i = 0; i < objects.length; i++){
    var o = objects[i];
    try{ disposeObjectRecursive(o); }catch(e){}
    scene.remove(o);
    if (o !== b){
      tmp.push(o);
      scene.add(o);
    }
  }
  objects = tmp;

  if (b.userData && b.userData.solid){
    tmp = [];
    for (i = 0; i < pickables.length; i++){
      if (pickables[i] !== b) tmp.push(pickables[i]);
    }
    pickables = tmp;
  } else {
    var kidsSet = {};
    for (i = 0; i < b.children.length; i++){
      kidsSet[b.children[i].uuid] = true;
    }
    tmp = [];
    for (i = 0; i < pickables.length; i++){
      var p = pickables[i];
      if (!(kidsSet[p.uuid] || p === b)){
        tmp.push(p);
      }
    }
    pickables = tmp;
  }

  updateCounter();
  try{ disposeObjectRecursive(b); }catch(e){}
  msg('Deleted', true);

  pushState();

  // Refresh ghost state after deletion so we can place at the same spot
  try{
    if (ghost){
      onMove({ clientX: e.clientX, clientY: e.clientY });
    }
  }catch(_){}
}


  function clearAll(){
    for(var i=0;i<objects.length;i++){
      try{ disposeObjectRecursive(objects[i]); }catch(e){}
    scene.remove(objects[i]);
    
  try{ clearAllWrappers(); }catch(e){}
}
    objects=[];
    pickables=[];
    updateCounter();
    msg('Scene cleared', true);
  }

  function updateCounter(){
var c=el('cnt');
    if(c) c.textContent=String(objects.length);
    var sb=document.getElementById('statsBadgeCnt'); if(sb) sb.textContent=String(objects.length);
    var hc=document.getElementById('hudCnt'); if(hc) hc.textContent=String(objects.length);
    updateFacetStats();
  }

  // rotate camera around lastPlacedCenter horizontally (Y axis)
  function rotateAroundPivotY(pivot, angle){
    if(!pivot) return;
    var rel=camera.position.clone().sub(pivot);
    var cos=Math.cos(angle), sin=Math.sin(angle);

    var nx =  rel.x *  cos + rel.z * sin;
    var nz = -rel.x *  sin + rel.z * cos;

    rel.x = nx;
    rel.z = nz;

    camera.position.copy(pivot.clone().add(rel));
    controls.target.copy(pivot);
  }

  // WASD / E / F / Q / R camera control
  function updateKeyboardCamera(){
    if(!camera || !controls) return;

    var moveSpeed=0.25;
    var rotSpeed=0.08;

    var moved=false;
    var delta=new THREE.Vector3(0,0,0);

    var upVec=new THREE.Vector3(0,1,0);
    var dir=new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.normalize();

    var strafe=new THREE.Vector3();
    strafe.crossVectors(dir, upVec).normalize();

    if(keyState.w){ delta.addScaledVector(dir, moveSpeed); moved=true; }
    if(keyState.s){ delta.addScaledVector(dir,-moveSpeed); moved=true; }
    if(keyState.a){ delta.addScaledVector(strafe,-moveSpeed); moved=true; }
    if(keyState.d){ delta.addScaledVector(strafe, moveSpeed); moved=true; }
    if(keyState.e){ delta.addScaledVector(upVec, moveSpeed); moved=true; }
    if(keyState.f){ delta.addScaledVector(upVec,-moveSpeed); moved=true; }

    if(moved){
      camera.position.add(delta);
      controls.target.add(delta);
    }

    // Q/R orbit camera horizontally around lastPlacedCenter
    if(keyState.q || keyState.r){
      var da=0;
      if(keyState.q) da += rotSpeed;
      if(keyState.r) da -= rotSpeed;
      rotateAroundPivotY(lastPlacedCenter, da);
    }
  }

  
// --- Queue pointer-move to next animation frame (injected) ---
var __queuedMoveEvt = null;
var __queuedPrevMoveEvt = null;
function onMoveQueued(e){ __queuedMoveEvt = e; }
function onPreviewMoveQueued(e){ __queuedPrevMoveEvt = e; }
function animate(){
    requestAnimationFrame(animate);
    try{ __syncWrappers(); }catch(e){}
    try{ if(__queuedMoveEvt){ onMove(__queuedMoveEvt); __queuedMoveEvt=null; } }catch(e){}
    try{ if(__queuedPrevMoveEvt){ onPreviewMove(__queuedPrevMoveEvt); __queuedPrevMoveEvt=null; } }catch(e){}
    if(controls) controls.update();
    if(typeof updateKeyboardCamera === 'function'){ updateKeyboardCamera(); }

    if(!renderer) return;

    // First draw the fullscreen gradient background, then the main 3D scene
    renderer.clear();
    if(bgScene && bgCamera){
      renderer.render(bgScene, bgCamera);
    }
    if(scene && camera){
      renderer.render(scene, camera);
    }
  }

// ===== Materials / block constructors =====
  function createMat(col){
    return new THREE.MeshStandardMaterial({
      color: toLinear(col),
      roughness:0.85,
      metalness:0.05,
      side:THREE.DoubleSide
    });
  }

  // Solid block (single mesh)
  function makeSolid(kind,colHexOrNum){
    var g=baseGeom[kind]||new THREE.BoxGeometry(1,1,1);
    var mat=createMat(colHexOrNum);

    try{
      mat.userData={
        baseHex: (typeof colHexOrNum==='string'
          ? colHexOrNum
          : '#'+(new THREE.Color(colHexOrNum)).getHexString())
      };
    }catch(e){
      mat.userData={ baseHex:'#7D7F7D' };
    }

    var m=new THREE.Mesh(g.clone(), mat);
    m.castShadow=true;
    m.userData={kind:kind,isBlock:true,solid:true};
    return m;
  }

  // Editable block (one mesh per face)
  function buildCubeGroup(type,colorHex){
    var group=new THREE.Group();
    group.userData={
      kind:type,
      isBlock:true,
      solid:false,
      faces:{},
      faceTypes:{}
    };

    var fgs=faceGeoms[type];
    if(!fgs){
      return group;
    }

    var dirs=['top','bottom','front','back','left','right'];
    for(var i=0;i<dirs.length;i++){
      var dir=dirs[i];
      var geom=fgs[dir];
      if(!geom) continue;

      var mat=createMat(colorHex);
      mat.userData={ baseHex: colorHex, _isolated:true };

      var mesh=new THREE.Mesh(geom.clone(), mat);
      mesh.castShadow=true;
      mesh.name='face_'+dir;
      mesh.userData={isFace:true,faceDir:dir};

      group.add(mesh);
      group.userData.faces[dir]=mesh;

      // Если это кастомный вид, восстанавливаем тип грани из сохранённого префаба
      var faceTypeForDir = type;
      try{
        if (customKinds && customKinds[type] && customKinds[type].faceTypes && customKinds[type].faceTypes[dir]){
          faceTypeForDir = customKinds[type].faceTypes[dir];
        }
      }catch(e){}
      group.userData.faceTypes[dir]=faceTypeForDir;

      pickables.push(mesh);
    }
    return group;
  }

  // Make solid block editable if needed
  function ensureEditableSelected(){
    var b=selectedBlock;
    if(!b) return b;
    if(!b.userData || !b.userData.solid){
      return b;
    }

    var kind=b.userData.kind;
    var hex='#7D7F7D';

    try{
      if(b.material && b.material.userData && b.material.userData.baseHex){
        hex=b.material.userData.baseHex;
      } else if(b.material && b.material.color){
        hex='#'+b.material.color.getHexString();
      }
    }catch(e){}

    var g=buildCubeGroup(kind, hex);
    g.position.copy(b.position);
    g.rotation.copy(b.rotation);
    g.scale.copy(b.scale);

    scene.remove(b);
    try{ removeWrapperForBlock(b); }catch(e){}
    scene.add(g);
    try{ createWrapperForBlock(g); updateSnapTargets(); }catch(e){}

    var tmp=[], i;
    for(i=0;i<objects.length;i++){
      tmp.push(objects[i]===b? g : objects[i]);
    }
    objects=tmp;

    var tmp2=[];
    for(i=0;i<pickables.length;i++){
      if(pickables[i]!==b) tmp2.push(pickables[i]);
    }
    pickables=tmp2;

    selectedBlock=g; try{ window.selectedBlock = selectedBlock; }catch(e){}
    return g;
  }

  // ===== Editor preview =====
  function ensurePreview(){
    var wrap=el('previewWrap');
    if(!wrap) return;

    if(!previewRenderer){
      var w=Math.max(1, wrap.clientWidth||320),
          h=Math.max(1, wrap.clientHeight||240);
      previewRenderer=new THREE.WebGLRenderer({antialias:true});
      
    
      setupColorPipeline(previewRenderer);
      previewRenderer.setClearColor(0x050814, 1);
      previewRenderer.setPixelRatio(window.devicePixelRatio||1);
      previewRenderer.setSize(w,h);
      wrap.appendChild(previewRenderer.domElement);

      previewRenderer.domElement.addEventListener('pointermove', onPreviewMoveQueued);
      previewRenderer.domElement.addEventListener('click', onPreviewClick);

      window.addEventListener('resize', onPreviewResize);
    }

    if(!previewScene){
      previewScene=new THREE.Scene();
      previewScene.background=new THREE.Color(0x050814);
      previewScene.add(new THREE.AmbientLight(0xffffff, 0.8));
      var dl=new THREE.DirectionalLight(0xffffff, 1.0);
      dl.position.set(6,8,6);
      previewScene.add(dl);
    }

    if(!previewCamera){
      var w2=Math.max(1, wrap.clientWidth||320),
          h2=Math.max(1, wrap.clientHeight||240);
      previewCamera=new THREE.PerspectiveCamera(55, w2/h2, 0.1, 100);
      previewCamera.position.set(2.2,1.7,2.2);
    }

    if(!previewControls && THREE.OrbitControls){
      previewControls=new THREE.OrbitControls(previewCamera, previewRenderer.domElement);
      previewControls.enableDamping=false;
      previewControls.enablePan=false;
      previewControls.minDistance=0.8;
      previewControls.maxDistance=8;
    }

    if(!previewRaycaster){
      previewRaycaster=new THREE.Raycaster();
    }
    if(!previewMouse){
      previewMouse=new THREE.Vector2();
    }

    if(!previewTicker){
      previewTicker=true;
      requestAnimationFrame(tickPreview);
    }
  }

  function tickPreview(){
    try{
      if(previewRenderer && previewScene && previewCamera){
        if(previewControls && previewControls.update){
          previewControls.update();
        }
        previewRenderer.render(previewScene, previewCamera);
      }
    }catch(err){}
    if(previewTicker){
      requestAnimationFrame(tickPreview);
    }
  }

  function onPreviewResize(){
    if(!previewRenderer||!previewCamera) return;
    var wrap=el('previewWrap');
    if(!wrap) return;

    var w=Math.max(1, wrap.clientWidth||320),
        h=Math.max(1, wrap.clientHeight||240);

    previewRenderer.setSize(w,h);
    previewCamera.aspect=w/h;
    previewCamera.updateProjectionMatrix();
  }

  function clearPreviewRoot(){
    if(previewRoot && previewRoot.parent){
      previewRoot.parent.remove(previewRoot);
    }
    previewRoot=null;
  }

  function clearPreviewOutline(){
    if(previewOutline && previewOutline.parent){
      previewOutline.parent.remove(previewOutline);
    }
    previewOutline=null;
  }

  function faceDirFromObject(o){
    var x=o;
    while(x){
      if(x.userData && x.userData.faceDir){
        return x.userData.faceDir;
      }
      x=x.parent;
    }
    return null;
  }

  function getPreviewFaceByDir(dir){
    if(!previewRoot) return null;
    for(var i=0;i<previewRoot.children.length;i++){
      var ch=previewRoot.children[i];
      if(ch.userData && ch.userData.faceDir===dir){
        return ch;
      }
    }
    return null;
  }

  function setPreviewOutline(mesh){
    clearPreviewOutline();
    if(!mesh||!mesh.geometry) return;
    try{
      // Контурная подсветка кубика в превью, без заливки
      var g=new THREE.EdgesGeometry(mesh.geometry, 40);
      var mat=new THREE.LineBasicMaterial({
        color: computeOverlay(),
        transparent:true,
        opacity:0.9,
        depthWrite:false,
        depthTest:false
      });
      var outline=new THREE.LineSegments(g, mat);
      outline.scale.setScalar(1.01);
      outline.position.copy(mesh.position);
      outline.rotation.copy(mesh.rotation);
      outline.renderOrder=999;

      previewOutline=outline;
      if(mesh.parent){
        mesh.parent.add(outline);
      }
    }catch(err){}
  }

  function rebuildPreviewFromSelected(){
    var hint=el('previewHint');
    if(!selectedBlock){
      clearPreviewRoot();
      if(hint) hint.textContent='No cubik selected';
      return;
    }

    ensurePreview();

    var blk=ensureEditableSelected();
    if(!blk){
      clearPreviewRoot();
      return;
    }
    if(hint) hint.textContent='';

    clearPreviewRoot();
    previewRoot=new THREE.Group();
    previewRoot.name='previewRoot';
    previewScene.add(previewRoot);

    // Обновляем мировые матрицы выбранного куба, чтобы превью повторяло его поворот
    blk.updateMatrixWorld(true);

    var dirs=['top','bottom','front','back','left','right'];
    for(var i=0;i<dirs.length;i++){
      var dir=dirs[i];
      var faceMesh=blk.userData && blk.userData.faces
        ? blk.userData.faces[dir]
        : null;
      if(!faceMesh) continue;

      var gg=faceMesh.geometry.clone();
      var mm=faceMesh.material.clone();
      var m2=new THREE.Mesh(gg,mm);

      m2.userData={faceDir:dir,original:faceMesh};

      // Копируем полный мировой трансформ грани (включая поворот всего куба)
      try{
        var wPos=new THREE.Vector3();
        var wQuat=new THREE.Quaternion();
        var wScale=new THREE.Vector3();
        faceMesh.updateMatrixWorld(true);
        faceMesh.matrixWorld.decompose(wPos,wQuat,wScale);
        m2.position.copy(wPos);
        m2.quaternion.copy(wQuat);
        m2.scale.copy(wScale);
      }catch(e){
        // Фоллбек — локальные координаты, если что-то пошло не так
        m2.position.copy(faceMesh.position);
        m2.rotation.copy(faceMesh.rotation);
        m2.scale.copy(faceMesh.scale);
      }

      previewRoot.add(m2);
    }

    previewRoot.updateMatrixWorld(true);

    var box=new THREE.Box3().setFromObject(previewRoot);
    var center=box.getCenter(new THREE.Vector3());
    var size=box.getSize(new THREE.Vector3());
    var maxDim=Math.max(size.x,size.y,size.z);

    var fov=previewCamera.fov*(Math.PI/180);
    var cameraDist=maxDim/(2*Math.tan(fov/2));
    cameraDist*=1.2;

    previewCamera.position.set(
      center.x+cameraDist,
      center.y+cameraDist*0.4,
      center.z+cameraDist
    );
    previewCamera.lookAt(center);
    previewCamera.updateProjectionMatrix();

    if(previewControls){
      previewControls.target.copy(center);
    }

    updatePreviewHighlight();
  }

  function updatePreviewHighlight(){
    if(!previewRoot) return;
    for(var i=0;i<previewRoot.children.length;i++){
      var child=previewRoot.children[i];
      var dir=child.userData?child.userData.faceDir:null;
      var on=!!selectedFaces[dir];
      if(on){
        if(child.material && child.material.emissive){
          child.material.emissive.setHex(computeOverlay());
          child.material.emissiveIntensity=1.0;
        }
      } else {
        if(child.material && child.material.emissive){
          child.material.emissive.setHex(0x000000);
          child.material.emissiveIntensity=0;
        }
      }
    }
  }

  function onPreviewMove(e){
    if(!previewRenderer||!previewScene||!previewCamera) return;

    if(hoverSuppressUntil && (typeof performance!=='undefined') &&
       performance.now()<hoverSuppressUntil){
      return;
    }

    var rect=previewRenderer.domElement.getBoundingClientRect();
    previewMouse.x=((e.clientX-rect.left)/rect.width)*2-1;
    previewMouse.y=-((e.clientY-rect.top)/rect.height)*2+1;

    if(!previewRoot||previewRoot.children.length===0) return;

    previewRaycaster.setFromCamera(previewMouse, previewCamera);
    var hits=previewRaycaster.intersectObjects(previewRoot.children,true);

    var picked=null;
    for(var i=0;i<hits.length;i++){
      var obj=hits[i].object;
      if(obj!==previewOutline){
        picked=hits[i];
        break;
      }
    }

    if(picked){
      var dir=faceDirFromObject(picked.object);
      var real=dir ? getPreviewFaceByDir(dir) : null;
      if(real){
        setPreviewOutline(real);
      }
      drawHoverOverlay(dir);
    } else {
      clearPreviewOutline();
      clearHoverOverlay();
    }
  }

  function onPreviewClick(e){
    if(!previewRenderer||!previewScene||!previewCamera) return;

    var rect=previewRenderer.domElement.getBoundingClientRect();
    previewMouse.x=((e.clientX-rect.left)/rect.width)*2-1;
    previewMouse.y=-((e.clientY-rect.top)/rect.height)*2+1;

    if(!previewRoot||!previewRaycaster) return;

    previewRaycaster.setFromCamera(previewMouse, previewCamera);
    var hits=previewRaycaster.intersectObjects(previewRoot.children,true);

    var picked=null;
    for(var i=0;i<hits.length;i++){
      var obj=hits[i].object;
      if(obj!==previewOutline){
        picked=hits[i];
        break;
      }
    }

    if(picked){
      var dir=faceDirFromObject(picked.object);
      if(dir){
        if(e.shiftKey){
          selectedFaces[dir]=!selectedFaces[dir];
        } else {
          clearSelected();
          selectedFaces[dir]=true;
        }
        updateFaceButtons();
        updatePreviewHighlight();
        drawSelectedOverlays();

        if(typeof performance!=='undefined'){
          hoverSuppressUntil=performance.now()+140;
        }
      }
    }
  }

  // ===== Scene overlays (selected / hover faces) =====
  var faceOverlaySelected=null, faceOverlayHover=null;

  function clearSelectedOverlays(){
    if(faceOverlaySelected && faceOverlaySelected.parent){
      faceOverlaySelected.parent.remove(faceOverlaySelected);
    }
    faceOverlaySelected=null;
  }
  function clearHoverOverlay(){
    if(faceOverlayHover && faceOverlayHover.parent){
      faceOverlayHover.parent.remove(faceOverlayHover);
    }
    faceOverlayHover=null;
  }

  function drawSelectedOverlays(){
  clearSelectedOverlays();
  if(!selectedBlock) return;

  var blk = selectedBlock;
  var dirs = selectedList();
  if(dirs.length === 0) return;

  faceOverlaySelected = new THREE.Group();

  for(var i = 0; i < dirs.length; i++){
    var d = dirs[i];
    var f = blk.userData.faces[d];
    if(!f) continue;

    // Подсветка только рёбер грани, без заливки
    var g = new THREE.EdgesGeometry(f.geometry, 40);

    var mat = new THREE.LineBasicMaterial({
      color: computeOverlay(),
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false
    });

    var overlay = new THREE.LineSegments(g, mat);
    overlay.position.copy(f.position);
    overlay.rotation.copy(f.rotation);
    overlay.scale.copy(f.scale).multiplyScalar(1.02);
    overlay.renderOrder = 999;

    faceOverlaySelected.add(overlay);
  }

  blk.add(faceOverlaySelected);
  renderer.render(scene, camera);
}
function drawHoverOverlay(d){
  clearHoverOverlay();
  if(!d || !selectedBlock) return;

  var blk = selectedBlock;
  var f = blk.userData.faces[d];
  if(!f) return;

  var g = new THREE.EdgesGeometry(f.geometry, 40);

  var mat = new THREE.LineBasicMaterial({
    color: computeOverlay(),
    transparent: true,
    opacity: 0.5,
    depthTest: false,
    depthWrite: false
  });

  var overlay = new THREE.LineSegments(g, mat);
  overlay.position.copy(f.position);
  overlay.rotation.copy(f.rotation);
  overlay.scale.copy(f.scale).multiplyScalar(1.04);
  overlay.renderOrder = 998;

  faceOverlayHover = overlay;
  blk.add(faceOverlayHover);
  renderer.render(scene, camera);
}


  function updateFaceButtons(){
    var root=el('faceButtons');
    if(!root) return;

    var btns=root.getElementsByTagName('button');
    for(var i=0;i<btns.length;i++){
      var b=btns[i];
      var dir=(b.getAttribute('data-face')||'').toLowerCase();
      var on=!!selectedFaces[dir];
      if(on){
        if(b.className.indexOf('active')===-1){
          b.className+=' active';
        }
      } else {
        b.className=b.className.replace(/\bactive\b/g,'').trim();
      }
    }

    var info=el('faceInfo');
    var list=selectedList();
    if(info){
      if(list.length===0){
        info.textContent='No facet selected';
      }else if(list.length===1){
        info.textContent='Facet selected: '+list[0];
      }else{
        info.textContent='Facets selected: '+list.length;
      }
    }
  }

  function selectBlock(b){
    if(selectedBlock===b) return;
    selectedBlock=b; try{ window.selectedBlock = selectedBlock; }catch(e){}
    clearSelected();
    updateFaceButtons();
    rebuildPreviewFromSelected();
    drawSelectedOverlays();
  }

  function openEditor(){
    el('editor').className='open';
    if(document.body.className.indexOf('editor-open')===-1){
      document.body.className+=' editor-open';
    }
    ensurePreview();
    rebuildPreviewFromSelected();
    drawSelectedOverlays();
    
    // Скрываем призрак при открытии редактора
    hideGhost();
  }

  function closeEditor(){
    el('editor').className='';
    document.body.className=document.body.className.replace(/\beditor-open\b/g,'').trim();
    clearSelectedOverlays();
    clearHoverOverlay();

    // Синхронизируем глобальную ориентацию Zen/2 с фактическим поворотом редактируемого блока
    try {
      if (selectedBlock && selectedBlock.userData && selectedBlock.userData.kind === 'Zen/2') {
        var twoPi = Math.PI * 2;
        function normAngle(a){
          a = a % twoPi;
          if (a < 0) a += twoPi;
          return a;
        }
        var rx = normAngle(selectedBlock.rotation.x);
        var rz = normAngle(selectedBlock.rotation.z);
        var eps = 0.01;
        var ori = 0;
        if (Math.abs(rx - Math.PI/2) < eps || Math.abs(rx - 3*Math.PI/2) < eps){
          ori = 1;
        } else if (Math.abs(rz - Math.PI/2) < eps || Math.abs(rz - 3*Math.PI/2) < eps){
          ori = 2;
        }
        zen2OrientationIndex = ori;
        zen2HalfCache = {};
      }
    } catch(e){}

    // После выхода из редактора перестраиваем призрак из последнего редактируемого куба
    try { window.adoptGhostFromEdited && window.adoptGhostFromEdited(selectedBlock); } catch(e) { dbgGhost('closeEditor adopt failed', e); }

    // Синхронизируем ориентацию призрака с повёрнутым блоком (чтобы копирование/построение сохраняло положение)
    try {
      if (selectedBlock && typeof ghost !== 'undefined' && ghost && ghost.rotation && selectedBlock.rotation){
        ghost.rotation.copy(selectedBlock.rotation);
      }
    } catch(e){}

    // Показываем призрак при закрытии редактора
    showGhost();
  }

  // ===== Paint / Replace logic =====
  function paintFaces(){
    if(!selectedBlock){
      msg('Select a cubik first', false);
      return false;
    
  try { pushState(); } catch(e) { /* noop */ }
}
    var blk=selectedBlock;
    var dirs=selectedList();
    if(dirs.length===0){
      msg('Select a facett', false);
      return false;
    }

    
    var paintHex = (typeof editorFaceHex==='string' && editorFaceHex) ? editorFaceHex : currentColorHex;
for(var i=0;i<dirs.length;i++){
      var d=dirs[i];
      var f=blk.userData.faces[d];
      if(f && f.material){
        if(!f.material.userData || !f.material.userData._isolated){
          f.material=f.material.clone();
          f.material.userData={_isolated:true, baseHex: paintHex};
        } else {
          f.material.userData.baseHex=paintHex;
        }
        var lin=toLinear(paintHex);
        f.material.color.copy(lin);
        f.material.needsUpdate=true;
      }
    }

    drawSelectedOverlays();
    updatePreviewHighlight();
    msg('Colored facets: '+dirs.length, true);

    try{
      rebuildPreviewFromSelected();
    }catch(err){}

    updateFacetStats();
    return true;
  }

  function replaceFaces(){
    if(!selectedBlock){
      msg('Select a cubik first', false);
      return false;
    }

    try { pushState(); } catch(e) { /* noop */ }

    var blk=ensureEditableSelected();
    var dirs=selectedList();
    if(dirs.length===0){
      msg('Select a facett', false);
      return false;
    }

    // Zen/2 rule:
    // cannot replace side faces (Left/Right/Front/Back),
    // only Top/Bottom
    if(blk && blk.userData && blk.userData.kind === 'Zen/2'){
      var forbidden = { left:1, right:1, front:1, back:1 };
      for(var ii=0; ii<dirs.length; ii++){
        var dLow = String(dirs[ii]).toLowerCase();
        if(forbidden[dLow]){
          msg('Cannot replace Zen/2 side facet. Only Top and Bottom are allowed', false);
          return false;
        }
      }
    }

    var targetType = selectedFaceType;
    if(!faceGeoms[targetType]){
      msg('No geometry for '+targetType, false);
      return false;
    }

    var replaced=0;
    for(var i=0;i<dirs.length;i++){
      var dir=String(dirs[i]).toLowerCase();
      var oldFace=blk.userData.faces[dir];
      if(!oldFace) continue;

      var fg=faceGeoms[targetType]||{};
      var newGeom=fg[dir];
      if(!newGeom) continue;

      var mat=oldFace.material;

      var basePos=oldFace.position.clone();
      var rot=oldFace.rotation.clone();
      var scl=oldFace.scale.clone();

      blk.remove(oldFace);

      // remove oldFace from pickables
      var tmp=[];
      for(var j=0;j<pickables.length;j++){
        if(pickables[j]!==oldFace){
          tmp.push(pickables[j]);
        }
      }
      pickables=tmp;

      var aligned=alignGeomPlaneTo(oldFace.geometry, newGeom, dir);
      var newFace=new THREE.Mesh(aligned, mat);
      newFace.castShadow=true;
      newFace.name='face_'+dir;
      newFace.userData={isFace:true,faceDir:dir};

      newFace.position.copy(basePos);
      newFace.rotation.copy(rot);
      newFace.scale.copy(scl);

      blk.add(newFace);
      blk.userData.faces[dir]=newFace;
      blk.userData.faceTypes[dir]=targetType;
      pickables.push(newFace);

      replaced++;
    }

    drawSelectedOverlays();
    updatePreviewHighlight();
    msg('Replaced facets: '+replaced, true);

    try{
      rebuildPreviewFromSelected();
    }catch(err){}

    updateFacetStats();
    return replaced>0;
  }

  // ===== Ghost & Gallery =====
  function makeGhost(kind){
    if(ghost){
      scene.remove(ghost);
    }
    var g=baseGeom[kind]||new THREE.BoxGeometry(1,1,1);
    ghost=new THREE.Mesh(
      g.clone(),
      new THREE.MeshBasicMaterial({
        color:0x6ee7b7,
        transparent:true,
        opacity:0.5,
        depthWrite:false
      })
    );
    try{ attachGhostWrapper(ghost); }catch(e){}
    ghost.visible=false;
    ghost.userData={ok:false};

    // Apply current orientation for Zen/2 ghost
    if(isZen2LikeKind(kind)){
      applyZen2Orientation(ghost);
    } else {
      ghost.rotation.set(0,0,0);
    }

    scene.add(ghost);
  }


  // Setter for ghostType that also rebuilds the ghost and updates UI
  function setGhostType(kind){
    try{
      ghostType = kind;
      if (typeof makeGhost === 'function') makeGhost(kind);
      try { document.getElementById('typ').textContent = kind; } catch(e) {}
      try { updateCounter && updateCounter(); } catch(e) {}
      try { window.ghostType = ghostType; } catch(e) {}
    }catch(e){ console && console.error('[GHOST] setGhostType error', e); }
  }
  // Expose to global
  try{ window.makeGhost = makeGhost; window.setGhostType = setGhostType; }catch(e){}

  function setupGallery(){
    var gal=el('gallery');
    var cards=gal.getElementsByClassName('card');

    for(var i=0;i<cards.length;i++){
      (function(card){
        var kind=card.getAttribute('data-kind');
        var canvas=card.getElementsByTagName('canvas')[0];

        var cardW = (card.clientWidth||0);
      var w = (cardW>0? cardW : (canvas.clientWidth||160));
      var h = 120;

        var r=new THREE.WebGLRenderer({
          antialias:true,
          canvas:canvas,
          alpha:true
        });
        setupColorPipeline(r);
        r.setSize(w,h,false);
        r.setPixelRatio(Math.min(window.devicePixelRatio||1, 1.5));

        var sc=new THREE.Scene();
        // Lighten gallery preview background so black cubes are visible
        sc.background = srgbColor('#1F2933');

        var cam=new THREE.PerspectiveCamera(35, w/h, 0.1, 50);
        cam.position.set(2.2,1.6,2.2);

              cam.lookAt(0,0,0);
sc.add(new THREE.AmbientLight(0xffffff, 0.8));
        var dl=new THREE.DirectionalLight(0xffffff, 1.0);
        dl.position.set(4,6,4);
        sc.add(dl);

        var g=baseGeom[kind]||new THREE.BoxGeometry(1,1,1);
        var m=new THREE.MeshStandardMaterial({
          color:toLinear(currentColorHex),
          roughness:1,
          metalness:0,
          side:THREE.DoubleSide
        });
        var g2 = g.clone(); if(g2.center){ g2.center(); }
      var mesh = new THREE.Mesh(g2, new THREE.MeshStandardMaterial({ color: toLinear(currentColorHex), roughness:0.85, metalness:0.05 }));
      mesh.position.set(0,0,0);
        sc.add(mesh);

        // Сохраняем сцену для обновления цвета
        galleryScenes[kind] = {
          scene: sc,
          camera: cam,
          renderer: r,
          mesh: mesh
        };

        // Кнопка поворота Zen/2: 0 -> X -> Z -> 0
        if(kind === 'Zen/2'){
          var rotateBtn = document.createElement('button');
          rotateBtn.className = 'card-rotate-btn';
          rotateBtn.type = 'button';
          rotateBtn.title = 'Поворачивать Zen/2: X → Z → 0';
          rotateBtn.textContent = '⟳';
          rotateBtn.addEventListener('click', function(ev){
            ev.stopPropagation();
            zen2OrientationIndex = (zen2OrientationIndex + 1) % 3;
            // reset cached half-extents for Zen/2
            zen2HalfCache = {};
            // обновляем превью
            applyZen2Orientation(mesh);
            // и призрак, если сейчас выбран Zen/2
            if(isZen2LikeKind(ghostType) && ghost){
              applyZen2Orientation(ghost);
              if(typeof updateGhost === 'function'){
                updateGhost();
              }
            }
          });
          card.appendChild(rotateBtn);
        }

        var ctr = { update:function(){} }; // controls disabled in gallery

        function frame(){
          mesh.rotation.y+=0.01;
          /* controls disabled */
r.render(sc, cam);
          requestAnimationFrame(frame);
        }
        frame();

        card.addEventListener('click', function(){
          selectGallery(kind);
          el('typeSelect').value=kind;
          ghostType=kind;
          makeGhost(ghostType);
        });
      })(cards[i]);
    }
  }

  // ===== Face Type Gallery =====
  function setupFaceTypeGallery(){
    var container = el('faceTypeGallery');
    if(!container) return;

    var faceTypes = ['Void', 'Zen', 'Bion'];
    
    faceTypes.forEach(function(kind, index){
      var card = document.createElement('div');
      card.className = 'face-type-card' + (index === 0 ? ' active' : '');
      card.setAttribute('data-type', kind);
      
      var canvas = document.createElement('canvas');
      card.appendChild(canvas);
      
      var label = document.createElement('div');
      label.className = 'face-type-label';
      label.textContent = kind;
      card.appendChild(label);
      
      container.appendChild(card);

      // Создаем сцену для иконки
      var w = 80;
      var h = 80;

      var renderer = new THREE.WebGLRenderer({
        antialias: true,
        canvas: canvas,
        alpha: true
      });
      
      setupColorPipeline(renderer);
renderer.setSize(w, h, false);
      renderer.setPixelRatio(1);

      var scene = new THREE.Scene();
// Камера смотрящая прямо на переднюю грань
      var camera = new THREE.PerspectiveCamera(45, w/h, 0.1, 10);
      camera.position.set(0, 0, 2.5);
      camera.lookAt(0, 0, 0);

      // Освещение
      var ambient = new THREE.AmbientLight(0xffffff, 0.4);
      scene.add(ambient);
      
      var frontLight = new THREE.DirectionalLight(0xffffff, 0.8);
      frontLight.position.set(0, 0, 2);
      scene.add(frontLight);
      
      var topLight = new THREE.DirectionalLight(0xffffff, 0.3);
      topLight.position.set(0, 2, 0);
      scene.add(topLight);

      // Создаем меш с БЕЛЫМ цветом
      var g = baseGeom[kind] || new THREE.BoxGeometry(1, 1, 1);
      var m = new THREE.MeshStandardMaterial({ color: toLinear('#FFFFFF'), roughness:0.7, metalness:0.2, side:THREE.DoubleSide });
      var g2 = g.clone(); if(g2.center){ g2.center(); }
      var mesh = new THREE.Mesh(g2, m);
      mesh.position.set(0,0,0);
      
      // Поворачиваем куб чтобы передняя грань смотрела на камеру
      mesh.rotation.y = Math.PI; // Поворачиваем на 180 градусов чтобы видеть переднюю грань
      
      scene.add(mesh);

      // Сохраняем сцену
      faceTypeScenes[kind] = {
        scene: scene,
        camera: camera,
        renderer: renderer,
        mesh: mesh
      };

      // Рендерим статичное изображение
      renderer.render(scene, camera);

      // Обработчик клика
      card.addEventListener('click', function(){
        selectFaceType(kind);
      });
    });
  }

  function selectFaceType(kind){
    selectedFaceType = kind;
    
    // Обновляем активную карточку
    var cards = document.querySelectorAll('.face-type-card');
    for(var i=0; i<cards.length; i++){
      var card = cards[i];
      var on = (card.getAttribute('data-type') === kind);
      if(on){
        if(card.className.indexOf('active') === -1){
          card.className += ' active';
        }
      } else {
        card.className = card.className.replace(/\bactive\b/g, '').trim();
      }
    }
  }

  function selectGallery(kind){
    var cards=el('gallery').getElementsByClassName('card');
    for(var i=0;i<cards.length;i++){
      var c=cards[i];
      var on=(c.getAttribute('data-kind')===kind);
      if(on){
        if(c.className.indexOf('active')===-1){
          c.className+=' active';
        }
      } else {
        c.className=c.className.replace(/\bactive\b/g,'').trim();
      }
    }
  }

  
// ===== Embedded models (OBJ from /models) =====
(function(){
  // Map logical kinds to .obj files in /models
  var OBJ_FILES = {
    "Void":  "models/Void.obj",
    "Zen":   "models/Zen.obj",
    "Bion":  "models/Bion.obj",
    "Zen/2": "models/Zen_2.obj"
  };

  function loadObjGeom(url){
    return new Promise(function(resolve, reject){
      try{
        var loader = new THREE.OBJLoader();
        loader.load(
          url,
          function(root){
            try{
              var geoms = [];
              root.traverse(function(ch){
                try{ if (ch.isMesh && ch.geometry) geoms.push(ch.geometry); }catch(_){}
              });

              var g = null;
              if (geoms.length === 0){
                g = new THREE.BoxGeometry(1,1,1);
              } else {
                if (geoms.length > 1){
                  try{
                    if (THREE.BufferGeometryUtils && THREE.BufferGeometryUtils.mergeBufferGeometries){
                      g = THREE.BufferGeometryUtils.mergeBufferGeometries(geoms, true);
                    }else{
                      g = geoms[0];
                    }
                  }catch(e){
                    g = geoms[0];
                  }
                } else {
                  g = geoms[0];
                }
                g = g.clone();
                try{
                  g.computeBoundingBox();
                  var size = new THREE.Vector3();
                  g.boundingBox.getSize(size);
                  var s = 1 / Math.max(size.x, size.y, size.z || 1);
                  g.scale(s, s, s);
                  g.center();
                  g.computeVertexNormals();
                }catch(e){}
              }
              resolve(g);
            }catch(e){
              reject(e);
            }
          },
          undefined,
          function(err){ reject(err); }
        );
      }catch(e){
        reject(e);
      }
    });
  }

  function embeddedInit(){
    var keys = Object.keys(OBJ_FILES);
    var promises = keys.map(function(k){
      return loadObjGeom(OBJ_FILES[k]).then(function(g){
        return { key:k, geom:g };
      });
    });

    Promise.all(promises).then(function(results){
      // Fill baseGeom
      baseGeom = {};
      results.forEach(function(r){
        baseGeom[r.key] = r.geom;
      });

      // Build per-face geometries
      faceGeoms = {};
      for (var k in baseGeom){
        if (!Object.prototype.hasOwnProperty.call(baseGeom, k)) continue;
        var src = baseGeom[k];
        if (!src || typeof src.clone !== 'function') src = new THREE.BoxGeometry(1,1,1);
        try{
          faceGeoms[k] = makeBoxFacesFromGeometry(src);
        }catch(err){
          faceGeoms[k] = makeBoxFacesFromGeometry(new THREE.BoxGeometry(1,1,1));
        }
      }

      // Show UI and start app
      var ui = document.getElementById('ui'); if (ui) ui.style.display = 'block';
      var stats = document.getElementById('stats'); if (stats) stats.style.display = 'block';

      if (typeof initApp === 'function') initApp();

      try { hideLoaderWithStartupMin(); } catch(_){}
    }).catch(function(e){
      try{ console.error('[OBJ] init error', e); }catch(_){}
      try{
        baseGeom = {
          "Void":  new THREE.BoxGeometry(1,1,1),
          "Zen":   new THREE.BoxGeometry(1,1,1),
          "Bion":  new THREE.BoxGeometry(1,1,1),
          "Zen/2": new THREE.BoxGeometry(1,1,1)
        };
        faceGeoms = {};
        for (var k in baseGeom){
          if (!Object.prototype.hasOwnProperty.call(baseGeom, k)) continue;
          faceGeoms[k] = makeBoxFacesFromGeometry(baseGeom[k]);
        }
        if (typeof initApp === 'function') initApp();
      }catch(e2){}
      try { hideLoaderWithStartupMin(); } catch(_){ }
    });
  }

  document.addEventListener('DOMContentLoaded', function(){
    try { if (typeof openHelp === 'function') openHelp(); } catch(_){}
    try { showLoader(); } catch(_){}
    embeddedInit();
  });
})();
// ===== End embedded models =====// ===== End embedded models =====


// ===== App init after models loaded =====
  function initApp(){
    setupScene();
    setupGallery();
    setupFaceTypeGallery();

    // Build color palettes (main + editor face)
    buildPalette('palette', function(hex){
      setRAL(hex);
      var rr=el('ralSelect');
      if(rr){
        rr.value=hex;
        var ev=document.createEvent('HTMLEvents');
        ev.initEvent('change', true, false);
        rr.dispatchEvent(ev);
      }
    });

    buildPalette('paletteFace', function(hex){
  editorFaceHex = hex; // decoupled from main palette
  if(selectedBlock && selectedList().length>0){
    if(paintFaces()){
      pushState();
    }
  }
});

    // set initial color
    var ralSelect=el('ralSelect');
    if(ralSelect){
      setRAL(ralSelect.value);
    }

    // init ghost + default type — Bion
    setGhostType('Bion');

    // place first block at origin so user sees something
    var b=makeSolid('Bion', currentColorHex);
    b.position.set(0, getHalf('Bion').y, 0);
    scene.add(b);
    objects.push(b);
    try{ createWrapperForBlock(b); }catch(e){}
    pickables.push(b);
    lastPlacedCenter.copy(b.position);

    animate();
    updateCounter();
    selectGallery('Bion');
    updateFacetStats();

    // facet stats panel collapse toggle
    var fs=el('facetStats');
    var side=el('facetSideToggle');
    if(fs && side){
      var saved=null;
      try{
        saved=localStorage.getItem('facetCollapsed');
      }catch(e){}
      if(saved==='1'){
        if(fs.className.indexOf('collapsed')===-1){
          fs.className+=(fs.className?' ':'')+'collapsed';
        }
        side.setAttribute('aria-expanded','false');
        side.textContent='▶';
        side.title='Expand';
      } else {
        side.setAttribute('aria-expanded','true');
        side.textContent='◀';
        side.title='Collapse';
      }

      side.addEventListener('click', function(){
        var cls=fs.className||'';
        var coll=cls.indexOf('collapsed')!==-1;
        if(coll){
          fs.className=cls.replace(/\bcollapsed\b/g,'').trim();
          side.setAttribute('aria-expanded','true');
          side.textContent='◀';
          side.title='Collapse';
          try{
            localStorage.setItem('facetCollapsed','0');
          }catch(e){}
        } else {
          fs.className=(cls?cls+' ':'')+'collapsed';
          side.setAttribute('aria-expanded','false');
          side.textContent='▶';
          side.title='Expand';
          try{
            localStorage.setItem('facetCollapsed','1');
          }catch(e){}
        }
      });
    }

    // GLB export
    var exportBtn = el('exportBtn');
    if(exportBtn){
      exportBtn.addEventListener('click', function(){
        exportGLB();
      });
    }

    
    // TXT stats export
    var exportStatsBtn = el('exportStatsBtn');
    if(exportStatsBtn){
      exportStatsBtn.addEventListener('click', function(){
        exportStatsTXT();
      });
    }

    // JSON export for backend
    var exportJsonBtn = el('exportJsonBtn');
    if(exportJsonBtn){
      exportJsonBtn.addEventListener('click', function(){
        exportProjectJSON();
      });
    }

    // JSON import (Load scene from JSON file)
    var importJsonBtn = el('importJsonBtn');
    var importJsonInput = el('importJsonInput');
    if(importJsonBtn && importJsonInput && typeof window.FileReader !== 'undefined'){
      importJsonBtn.addEventListener('click', function(){
        importJsonInput.click();
      });

      importJsonInput.addEventListener('change', function(ev){
        try{
          var file = ev.target && ev.target.files && ev.target.files[0];
          if(!file){
            return;
          }
          var reader = new FileReader();
          reader.onload = function(e){
            try{
              var text = String(e.target.result || '');
              if(typeof importProjectJSONFromText === 'function'){
                importProjectJSONFromText(text);
              }
            }catch(err){
              console && console.error && console.error('[Import JSON] onload error', err);
              try{ alert('Ошибка при загрузке JSON'); }catch(_){}
            }finally{
              try{ importJsonInput.value = ''; }catch(_){}
            }
          };
          reader.onerror = function(){
            try{ alert('Не удалось прочитать файл JSON'); }catch(_){}
          };
          reader.readAsText(file, 'utf-8');
        }catch(err){
          console && console.error && console.error('[Import JSON] change handler error', err);
        }
      });
    }

// initial undo snapshot
    pushState();
    hasUnsavedChanges = false;
    updateUndoRedoUI();
  }

  function buildPalette(containerId, onPick){
    var container=el(containerId);
    container.innerHTML='';

    for(var i=0;i<RALS.length;i++){
      (function(name,hex,idx){
        var d=document.createElement('div');
        d.className='dot'+(idx===0?' active':'');
        d.style.background=hex;
        d.title=name+' '+hex;

        d.addEventListener('click', function(){
          var dots=container.getElementsByClassName('dot');
          for(var j=0;j<dots.length;j++){
            dots[j].className = dots[j].className
              .replace(/\bactive\b/g,'')
              .trim();
          }
          d.className+=' active';
          onPick(hex);
        });

        container.appendChild(d);
      })(RALS[i][0], RALS[i][1], i);
    }

    var sw=el('sw');
    if(sw){
      sw.style.background=RALS[0][1];
    }
  }

  // ===== Facet stats =====
  function matBaseHex(mat){
    try{
      if(mat && mat.userData && mat.userData.baseHex){
        return hexNorm(mat.userData.baseHex);
      }
      if(mat && mat.color){
        return hexNorm('#'+mat.color.getHexString());
      }
    }catch(e){}
    return '#7D7F7D';
  }

  function ralName(hex){
    var h=hexNorm(hex);
    return RAL_REV[h] ? RAL_REV[h] : h;
  }

  function computeTotalPriceFromFacetMap(map){
  if(!map) return 0;
  var prices = {
    'Bion': 1.95,
    'Zen': 2.05,
    'Void': 1.58,
    'Zen/2': 1.58
  };
  var total = 0;
  for (var type in map){
    if(!Object.prototype.hasOwnProperty.call(map, type)) continue;
    var bucket = map[type];
    if(!bucket) continue;
    var facets = 0;
    for (var colorHex in bucket){
      if(!Object.prototype.hasOwnProperty.call(bucket, colorHex)) continue;
      facets += bucket[colorHex];
    }
    var unit = prices.hasOwnProperty(type) ? prices[type] : 0;
    total += facets * unit;
  }
  return +total.toFixed(2);
}

function updateFacetStats(){
    // map[type][colorHex] = count of faces
    var map={};

    function inc(type,color,n){
      if(!map[type]) map[type]={};
      if(!map[type][color]) map[type][color]=0;
      map[type][color]+=n;
    }

    for(var i=0;i<objects.length;i++){
      var o=objects[i];
      if(!o||!o.userData) continue;

      if(o.userData.solid){
        var type=o.userData.kind||'Unknown';
        var hex=matBaseHex(o.material);

        // Zen/2 special stats rule:
        // it's NOT 6 faces Zen/2.
        // It's 4 Zen/2 faces + 2 Bion faces.
        if(type==='Zen/2'){
          inc('Zen/2',hex,4);
          inc('Bion',hex,2);
        } else {
          inc(type,hex,6);
        }

      } else if(o.userData.faces){
        var dirs=['top','bottom','front','back','left','right'];
        for(var j=0;j<dirs.length;j++){
          var d=dirs[j];
          var f=o.userData.faces[d];
          if(!f) continue;

          var t=(o.userData.faceTypes && o.userData.faceTypes[d])
            ? o.userData.faceTypes[d]
            : o.userData.kind || 'Unknown';

          var hx=matBaseHex(f.material);
          inc(t,hx,1);
        }
      }
    }

    renderFacetStats(map);

    try{
      var totalPrice = computeTotalPriceFromFacetMap(map);
      var hudPriceEl = document.getElementById('hudPrice');
      if(hudPriceEl){
        var v = totalPrice;
        var text = '$' + (Math.abs(v - Math.round(v)) < 0.005 ? Math.round(v).toString() : v.toFixed(2));
        hudPriceEl.textContent = text;
      }
    }catch(e){}

  }

  function renderFacetStats(map){
    var box=el('facetBody');
    if(!box) return;

    var types=['Void','Bion','Zen','Zen/2'];
    var hasAny=false;
    var html='';

    for(var ti=0; ti<types.length; ti++){
      var t=types[ti];
      if(!map[t]) continue;

      var total=0;
      for(var k in map[t]){
        if(map[t].hasOwnProperty(k)){
          total+=map[t][k];
        }
      }

      html+='<div class="type">';
      html+='<div class="name">'+t+': '+total+'</div>';
      html+='<div class="chips">';

      for(var k2 in map[t]){
        if(!map[t].hasOwnProperty(k2)) continue;
        var cnt=map[t][k2];
        html+='<div class="chip">';
        html+='<span class="sw" style="background:'+k2+'"></span>';
        html+='<span>'+ralName(k2)+': '+cnt+'</span>';
        html+='</div>';
      }

      html+='</div></div>';
      hasAny=true;
    }

    if(!hasAny){
      html+='<div class="muted">—</div>';
    }

    box.innerHTML=html;
  }

 // ===== Undo / Redo =====
function snapshotScene(){
  var snap=[];
  for(var i=0;i<objects.length;i++){
    var o=objects[i];
    if(!o || !o.userData) continue;

    if(o.userData.solid){
      var colorHex=matBaseHex(o.material);
      snap.push({
        type:'solid',
        kind:o.userData.kind,
        colorHex:colorHex,
        position:[o.position.x,o.position.y,o.position.z],
        rotation:[o.rotation.x,o.rotation.y,o.rotation.z],
        scale:[o.scale.x,o.scale.y,o.scale.z],
        uuid: o.uuid // сохраняем UUID для идентификации
      });
      continue;
    }

    if(o.userData.faces){
      var gSnap={
        type:'group',
        kind:o.userData.kind,
        position:[o.position.x,o.position.y,o.position.z],
        rotation:[o.rotation.x,o.rotation.y,o.rotation.z],
        scale:[o.scale.x,o.scale.y,o.scale.z],
        faces:{},
        uuid: o.uuid // сохраняем UUID
      };

      for(var dir in o.userData.faces){
        if(!o.userData.faces.hasOwnProperty(dir)) continue;
        var f=o.userData.faces[dir];
        if(!f) continue;

        var fColor=matBaseHex(f.material);
        var fType=(o.userData.faceTypes && o.userData.faceTypes[dir])
          ? o.userData.faceTypes[dir]
          : o.userData.kind;

        gSnap.faces[dir]={
          colorHex:fColor,
          faceType:fType,
          faceUuid: f.uuid // сохраняем UUID грани
        };
      }
      snap.push(gSnap);
    }
  }
  return snap;
}

function restoreScene(snapArr){
  // Временное хранилище для существующих объектов
  var existingObjects = {};
  for(var i=0;i<objects.length;i++){
    existingObjects[objects[i].uuid] = objects[i];
  }

  // Удаляем только те объекты, которых нет в снапшоте
  var objectsToRemove = [];
  for(var i=0;i<objects.length;i++){
    var obj = objects[i];
    var foundInSnapshot = false;
    
    for(var si=0; si<snapArr.length; si++){
      if(snapArr[si].uuid === obj.uuid){
        foundInSnapshot = true;
        break;
      }
    }
    
    if(!foundInSnapshot){
      objectsToRemove.push(obj);
    }
  }

  // Удаляем объекты, которых нет в снапшоте
  for(var i=0;i<objectsToRemove.length;i++){
    var obj = objectsToRemove[i];
    try{ removeWrapperForBlock(obj); }catch(e){}
    try{ disposeObjectRecursive(obj); }catch(e){}
    scene.remove(obj);
    
    var index = objects.indexOf(obj);
    if(index !== -1) objects.splice(index,1);
    
    // Удаляем из pickables
    if(obj.userData && obj.userData.solid){
      var pickIndex = pickables.indexOf(obj);
      if(pickIndex !== -1) pickables.splice(pickIndex,1);
    } else {
      // Для групп удаляем все дочерние грани
      for(var dir in obj.userData.faces){
        var face = obj.userData.faces[dir];
        var faceIndex = pickables.indexOf(face);
        if(faceIndex !== -1) pickables.splice(faceIndex,1);
      }
    }
  }

  // Восстанавливаем/обновляем объекты из снапшота
  for(var si=0; si<snapArr.length; si++){
    var s = snapArr[si];
    var existingObj = existingObjects[s.uuid];

    if(existingObj){
      // ОБНОВЛЯЕМ существующий объект
      existingObj.position.set(s.position[0], s.position[1], s.position[2]);
      existingObj.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);
      existingObj.scale.set(s.scale[0], s.scale[1], s.scale[2]);

      if(s.type === 'solid'){
        // Обновляем цвет solid блока
        var mat = createMat(s.colorHex);
        mat.userData = { baseHex: s.colorHex };
        existingObj.material = mat;
        
      } else if(s.type === 'group'){
        // Обновляем цвета, типы и геометрию граней группы
        for(var dir in s.faces){
          if(!s.faces.hasOwnProperty(dir)) continue;
          var fs = s.faces[dir];
          var faceMesh = existingObj.userData.faces[dir];

          if(faceMesh){
            // При необходимости подменяем геометрию грани в соответствии с faceType из снапшота
            var desiredType = fs.faceType || s.kind;
            try{
              if (desiredType && faceGeoms && faceGeoms[desiredType] && faceGeoms[desiredType][dir]){
                var newGeom = faceGeoms[desiredType][dir];
                var aligned = alignGeomPlaneTo(faceMesh.geometry, newGeom, dir);
                if (faceMesh.geometry && faceMesh.geometry.dispose){
                  faceMesh.geometry.dispose();
                }
                faceMesh.geometry = aligned;
              }
            }catch(e){}

            var mat = createMat(fs.colorHex);
            mat.userData = {_isolated:true, baseHex:fs.colorHex};
            faceMesh.material = mat;
            existingObj.userData.faceTypes[dir] = desiredType;
          }
        }
      }

} else {
      // СОЗДАЕМ новый объект (если его не было)
      if(s.type==='solid'){
        var m=makeSolid(s.kind, s.colorHex);
        m.position.set(s.position[0],s.position[1],s.position[2]);
        m.rotation.set(s.rotation[0],s.rotation[1],s.rotation[2]);
        m.scale.set(s.scale[0],s.scale[1],s.scale[2]);
        m.uuid = s.uuid; // сохраняем оригинальный UUID

        scene.add(m);
        objects.push(m);
        try{ createWrapperForBlock(m); }catch(e){}
        pickables.push(m);
        
      } else if(s.type==='group'){
        var grp = buildCubeGroup(s.kind, '#7D7F7D');
        grp.uuid = s.uuid; // сохраняем оригинальный UUID
        
        grp.position.set(s.position[0], s.position[1], s.position[2]);
        grp.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);
        grp.scale.set(s.scale[0], s.scale[1], s.scale[2]);

        // Обновляем цвета, типы и геометрию граней
        for(var dir in s.faces){
          if(!s.faces.hasOwnProperty(dir)) continue;
          var fs = s.faces[dir];
          var faceMesh = grp.userData.faces[dir];

          if(faceMesh){
            // При необходимости подменяем геометрию грани в соответствии с faceType из снапшота
            var desiredType = fs.faceType || s.kind;
            try{
              if (desiredType && faceGeoms && faceGeoms[desiredType] && faceGeoms[desiredType][dir]){
                var newGeom = faceGeoms[desiredType][dir];
                var aligned = alignGeomPlaneTo(faceMesh.geometry, newGeom, dir);
                if (faceMesh.geometry && faceMesh.geometry.dispose){
                  faceMesh.geometry.dispose();
                }
                faceMesh.geometry = aligned;
              }
            }catch(e){}

            var mat = createMat(fs.colorHex);
            mat.userData = {_isolated:true, baseHex:fs.colorHex};
            faceMesh.material = mat;
            grp.userData.faceTypes[dir] = desiredType;
          }
        }

scene.add(grp);
        objects.push(grp);
        try{ createWrapperForBlock(grp); }catch(e){}
      }
    }
  }

  // Обновляем pickables для новых объектов
  pickables = [];
  for(var i=0;i<objects.length;i++){
    var obj = objects[i];
    if(obj.userData && obj.userData.solid){
      pickables.push(obj);
    } else if(obj.userData && obj.userData.faces){
      for(var dir in obj.userData.faces){
        pickables.push(obj.userData.faces[dir]);
      }
    }
  }

  selectedBlock=null; 
  try{ window.selectedBlock = selectedBlock; }catch(e){}
  clearSelected();
  closeEditor();
  rebuildPreviewFromSelected();
  updateCounter();
  updateFacetStats();

  if(objects.length>0){
    lastPlacedCenter.copy(objects[objects.length-1].position);
  } else {
    resetPivot();
  }
}

function loadSceneFromSnapshot(snapArr){
  if (!Array.isArray(snapArr)) return;

  // Полностью очищаем текущую сцену от блоков
  try{
    for (var i = 0; i < objects.length; i++){
      var obj = objects[i];
      try{ removeWrapperForBlock(obj); }catch(e){}
      try{ disposeObjectRecursive(obj); }catch(e){}
      try{ scene.remove(obj); }catch(e){}

      // Чистим pickables
      if (obj.userData && obj.userData.solid){
        var idx = pickables.indexOf(obj);
        if (idx !== -1) pickables.splice(idx, 1);
      } else if (obj.userData && obj.userData.faces){
        for (var dir in obj.userData.faces){
          if (!obj.userData.faces.hasOwnProperty(dir)) continue;
          var f = obj.userData.faces[dir];
          var idx2 = pickables.indexOf(f);
          if (idx2 !== -1) pickables.splice(idx2, 1);
        }
      }
    }
  }catch(e){}

  objects = [];
  pickables = [];
  selectedBlock = null;
  try{ window.selectedBlock = null; }catch(e){}

  // Строим сцену целиком из снапшота
  for (var si = 0; si < snapArr.length; si++){
    var s = snapArr[si];
    if (!s) continue;

    if (s.type === 'solid'){
      var m = makeSolid(s.kind, s.colorHex || '#7D7F7D');
      m.position.set(s.position[0], s.position[1], s.position[2]);
      m.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);
      m.scale.set(s.scale[0], s.scale[1], s.scale[2]);
      if (s.uuid) m.uuid = s.uuid;

      scene.add(m);
      objects.push(m);
      pickables.push(m);
      try{ createWrapperForBlock(m); }catch(eSolid){}

    } else if (s.type === 'group'){
      var grp = buildCubeGroup(s.kind, '#7D7F7D');
      if (s.uuid) grp.uuid = s.uuid;

      grp.position.set(s.position[0], s.position[1], s.position[2]);
      grp.rotation.set(s.rotation[0], s.rotation[1], s.rotation[2]);
      grp.scale.set(s.scale[0], s.scale[1], s.scale[2]);

      if (s.faces && grp.userData && grp.userData.faces){
        for (var dir in s.faces){
          if (!s.faces.hasOwnProperty(dir)) continue;
          var fs = s.faces[dir];
          var faceMesh = grp.userData.faces[dir];
          if (!faceMesh) continue;

          var desiredType = fs.faceType || s.kind;
          try{
            if (desiredType && faceGeoms && faceGeoms[desiredType] && faceGeoms[desiredType][dir]){
              var newGeom = faceGeoms[desiredType][dir];
              var aligned = alignGeomPlaneTo(faceMesh.geometry, newGeom, dir);
              if (faceMesh.geometry && faceMesh.geometry.dispose){
                faceMesh.geometry.dispose();
              }
              faceMesh.geometry = aligned;
            }
          }catch(eGeom){}

          var mat = createMat(fs.colorHex || '#7D7F7D');
          mat.userData = { _isolated:true, baseHex:(fs.colorHex || '#7D7F7D') };
          faceMesh.material = mat;

          grp.userData.faceTypes[dir] = desiredType;
        }
      }

      scene.add(grp);
      objects.push(grp);
      try{ createWrapperForBlock(grp); }catch(eGrp){}
    }
  }

  // Пересобираем pickables (solid + грани)
  pickables = [];
  for (var i2 = 0; i2 < objects.length; i2++){
    var o2 = objects[i2];
    if (o2.userData && o2.userData.solid){
      pickables.push(o2);
    } else if (o2.userData && o2.userData.faces){
      for (var d in o2.userData.faces){
        if (!o2.userData.faces.hasOwnProperty(d)) continue;
        pickables.push(o2.userData.faces[d]);
      }
    }
  }

  clearSelected();
  closeEditor();
  rebuildPreviewFromSelected();
  updateCounter();
  updateFacetStats();

  if (objects.length > 0){
    lastPlacedCenter.copy(objects[objects.length-1].position);
  } else {
    resetPivot();
  }
}



function pushState(){
  if (isReplayingBuild) return; // не пишем историю во время таймлапса
  var snap = snapshotScene();
  undoStack.push(snap);
  redoStack = [];
  if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
  hasUnsavedChanges = undoStack.length > 1;
  updateUndoRedoUI();
}
function undoAction(){
  if (undoStack.length <= 1) {
    updateUndoRedoUI();
    return;
  }
  const currentSnap = undoStack.pop();
  redoStack.push(currentSnap);

  const prevSnap = undoStack[undoStack.length - 1];
  restoreScene(prevSnap);

  updateUndoRedoUI();
  msg('Undo', true);
}

function redoAction(){
  if (redoStack.length === 0) {
    updateUndoRedoUI();
    return;
  }
  const nextSnap = redoStack.pop();
  undoStack.push(nextSnap);
  restoreScene(nextSnap);
  updateUndoRedoUI();
  msg('Redo', true);
}



// ===== Timelapse / build replay =====

// Вспомогательная функция: блокируем UI во время воспроизведения
function setReplayUIBusy(busy){
  isReplayingBuild = busy;

  // затемняем левую панель, чтобы было понятно что идёт проигрывание
  var uiPanel = el('ui');
  if (uiPanel){
    uiPanel.style.pointerEvents = busy ? 'none' : '';
    uiPanel.style.opacity = busy ? 0.6 : '';
  }

  updateUndoRedoUI();
}

// Запуск записи Canvas -> WebM
function startCanvasRecording(){
  if (!renderer || !renderer.domElement || !renderer.domElement.captureStream){
    msg('Запись видео не поддерживается в этом браузере', true);
    return false;
  }

  var stream = renderer.domElement.captureStream(30);
  recordedChunks = [];

  try{
    mediaRecorder = new MediaRecorder(stream, { mimeType:'video/webm;codecs=vp9' });
  }catch(e){
    try{
      mediaRecorder = new MediaRecorder(stream, { mimeType:'video/webm' });
    }catch(e2){
      console.error(e2);
      msg('Не удалось запустить запись видео', true);
      return false;
    }
  }

  mediaRecorder.ondataavailable = function(e){
    if (e.data && e.data.size > 0){
      recordedChunks.push(e.data);
    }
  };
  mediaRecorder.onstop = function(){
    if (!recordedChunks || !recordedChunks.length) return;
    var blob = new Blob(recordedChunks, { type:'video/webm' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'build-timelapse.webm';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){
      URL.revokeObjectURL(url);
    }, 1000);
    recordedChunks = [];
  };

  mediaRecorder.start();
  return true;
}

function stopCanvasRecording(){
  if (mediaRecorder && mediaRecorder.state !== 'inactive'){
    mediaRecorder.stop();
  }
}

// Воспроизведение истории сборки (по undoStack).
// Если options.record === true — параллельно пишем видео.
function startBuildReplay(options){
  options = options || {};
  var withRecording = !!options.record;

  if (isReplayingBuild){
    return;
  }
  if (!undoStack || undoStack.length <= 1){
    msg('Нет истории сборки для воспроизведения', true);
    return;
  }

  // запоминаем финальное состояние, чтобы вернуть его в конце
  var finalSnap = snapshotScene();
  var snaps = undoStack.slice(0);
  var index = 0;

  if (withRecording){
    var ok = startCanvasRecording();
    if (!ok){
      withRecording = false;
    }
  }

  setReplayUIBusy(true);

  function step(){
    if (!isReplayingBuild){
      return;
    }
    if (index >= snaps.length){
      clearInterval(replayTimer);
      replayTimer = null;
      if (withRecording){
        stopCanvasRecording();
      }
      // возвращаем финальное состояние
      restoreScene(finalSnap);
      setReplayUIBusy(false);
      return;
    }
    var snap = snaps[index];
    index++;
    restoreScene(snap);
  }

  // стартуем немедленно
  step();
  replayTimer = setInterval(step, 80);
}

function updateUndoRedoUI(){
  var u = el('undoBtn');
  if (u){
    u.disabled = (undoStack.length <= 1) || isReplayingBuild;
  }
  var r = el('redoBtn');
  if (r){
    r.disabled = (redoStack.length === 0) || isReplayingBuild;
  }
  var rb = el('replayBuildBtn');
  if (rb){
    rb.disabled = (undoStack.length <= 1) || isReplayingBuild;
  }
  var vb = el('recordTimelapseBtn');
  if (vb){
    vb.disabled = (undoStack.length <= 1) || isReplayingBuild;
  }
}
// Warn about unsaved changes when leaving the page
window.addEventListener('beforeunload', function(e){
  if (!hasUnsavedChanges) return;
  var message = 'You have unsaved changes. If you leave, your project will be lost.';
  e.preventDefault();
  e.returnValue = message;
  return message;
});
  
  // ===== TXT Stats Export =====
  function hexToColorName(hex){
    // normalize hex to uppercase #RRGGBB
    if(!hex) return 'неизвестный цвет';
    var h = String(hex).toUpperCase();
    // Map known palette to Russian color names
    var map = {
      '#7D7F7D': 'серый',    // RAL 7037
      '#8A6642': 'коричневый', // RAL 1011
      '#4C9141': 'зелёный',  // RAL 6010
      '#F4F4F4': 'белый',    // RAL 9003
      '#0A0A0A': 'чёрный'    // RAL 9005
    };
    return map[h] || 'неизвестный цвет';
  }

  function buildFacetMap(){
    // map[type][colorHex] = count of faces (same logic as updateFacetStats)
    var map={};

    function inc(type,color,n){
      if(!map[type]) map[type]={};
      if(!map[type][color]) map[type][color]=0;
      map[type][color]+=n;
    }

    for(var i=0;i<objects.length;i++){
      var o=objects[i];
      if(!o||!o.userData) continue;

      if(o.userData.solid){
        var type=o.userData.kind||'Unknown';
        var hex=matBaseHex(o.material);

        // Zen/2 special stats rule: 4 Zen/2 + 2 Bion
        if(type==='Zen/2'){
          inc('Zen/2',hex,4);
          inc('Bion',hex,2);
        } else {
          inc(type,hex,6);
        }

      } else if(o.userData.faces){
        var dirs=['top','bottom','front','back','left','right'];
        for(var di=0; di<dirs.length; di++){
          var d=dirs[di];
          var f=o.userData.faces[d];
          if(!f) continue;

          var t=(o.userData.faceTypes && o.userData.faceTypes[d])
            ? o.userData.faceTypes[d]
            : o.userData.kind || 'Unknown';

          var hx=matBaseHex(f.material);
          inc(t,hx,1);
        }
      }
    }
    return map;
  }

  function exportStatsTXT(){
  var map = buildFacetMap();
  var types = Object.keys(map).sort();

  // Unit prices per 1 facet (EUR)
  var prices = {
    'Bion': 1.95,
    'Zen': 2.05,
    'Void': 1.58,
    'Zen/2': 1.58
  };

  function colorNameEN(hex){
    // Use English names only for export; fall back to hex
    var h = String(hex || '').toUpperCase();
    var dict = {
      '#7D7F7D': 'gray',
      '#8A6642': 'brown',
      '#4C9141': 'green',
      '#F4F4F4': 'white',
      '#0A0A0A': 'black'
    };
    return dict[h] || h || 'unknown';
  }

  function fmt(n){ return (+n).toFixed(2); }

  var lines = [];
  var grandTotalFacets = 0;
  var grandTotalPrice = 0;

  lines.push('=== Facet Statistics ===');
  lines.push('');

  for (var i=0; i<types.length; i++){
    var t = types[i];
    var byColor = map[t];
    var colorKeys = Object.keys(byColor);
    if (colorKeys.length === 0) continue;

    lines.push('Type: ' + t);
    var typeTotal = 0;

    // Sort by color name for readability
    colorKeys.sort(function(a,b){
      var na = colorNameEN(a);
      var nb = colorNameEN(b);
      if(na<nb) return -1; if(na>nb) return 1; return 0;
    });

    for (var j=0; j<colorKeys.length; j++){
      var hex = colorKeys[j];
      var count = byColor[hex];
      var name = colorNameEN(hex);
      lines.push('  ' + name + ': ' + count);
      typeTotal += count;
    }
    lines.push('  Total by type: ' + typeTotal);
    lines.push('');

    grandTotalFacets += typeTotal;
  }

  lines.push('Grand total facets: ' + grandTotalFacets);
  lines.push('');

  // Pricing section
  lines.push('=== Pricing ===');
  lines.push('Unit price per 1 facet:');
  lines.push('  Bion - 1.95 €');
  lines.push('  Zen - 2.05 €');
  lines.push('  Void - 1.58 €');
  lines.push('  ZEN/2 - 1.58 €');
  lines.push('');

  // Totals by type
  lines.push('=== Totals by Type ===');
  for (var k=0; k<types.length; k++){
    var type = types[k];
    var subtotalFacets = 0;
    var bucket = map[type];
    for (var colorHex in bucket){
      if (Object.prototype.hasOwnProperty.call(bucket, colorHex)){
        subtotalFacets += bucket[colorHex];
      }
    }
    var unit = prices.hasOwnProperty(type) ? prices[type] : 0;
    var subtotalPrice = +(subtotalFacets * unit).toFixed(2);
    lines.push('  ' + type + ': ' + subtotalFacets + ' facets × ' + fmt(unit) + ' € = ' + fmt(subtotalPrice) + ' €');
    grandTotalPrice += subtotalPrice;
  }
  lines.push('');
  lines.push('Grand total price: ' + fmt(grandTotalPrice) + ' €');

  var txt = lines.join('\n');
  var blob = new Blob([txt], {type:'text/plain;charset=utf-8'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'stats.txt';
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}


// ===== Custom kinds serialization for JSON export/import =====
  var _bufferGeomLoader = null;
  function getBufferGeomLoader(){
    if(!_bufferGeomLoader && typeof THREE !== 'undefined' && THREE.BufferGeometryLoader){
      _bufferGeomLoader = new THREE.BufferGeometryLoader();
    }
    return _bufferGeomLoader;
  }

  function serializeGeometryForJSON(geom){
    if(!geom || typeof geom.toJSON !== 'function') return null;
    try{
      var g = geom;
      if(g.toNonIndexed){
        g = g.toNonIndexed();
      }
      return g.toJSON();
    }catch(e){
      try{ console && console.warn && console.warn('[CustomKinds] serializeGeometry failed', e); }catch(_){}
      return null;
    }
  }

  function reviveGeometryFromJSON(json){
    if(!json) return null;
    var loader = getBufferGeomLoader();
    if(!loader) return null;
    try{
      // BufferGeometryLoader.parse понимает объект, возвращённый BufferGeometry.toJSON()
      return loader.parse(json);
    }catch(e){
      try{ console && console.warn && console.warn('[CustomKinds] reviveGeometry failed', e); }catch(_){}
      return null;
    }
  }

  // Собираем список используемых типов из снапшота
  function collectUsedKindsFromSnapshot(snap){
    var used = {};
    if(!Array.isArray(snap)) return used;

    for(var i = 0; i < snap.length; i++){
      var s = snap[i];
      if(!s) continue;

      if(s.kind){
        used[s.kind] = true;
      }

      if(s.faces){
        for(var dir in s.faces){
          if(!Object.prototype.hasOwnProperty.call(s.faces, dir)) continue;
          var fs = s.faces[dir];
          if(fs && fs.faceType){
            used[fs.faceType] = true;
          }
        }
      }
    }
    return used;
  }

  // сериализация только реально используемых кастомных типов
  function serializeCustomKindsForSnapshot(snap){
    if(!customKinds) return null;

    var usedKinds = collectUsedKindsFromSnapshot(snap);
    var result = {};
    var dirs = ['top','bottom','front','back','left','right'];

    for(var kind in usedKinds){
      if(!Object.prototype.hasOwnProperty.call(usedKinds, kind)) continue;
      var ck = customKinds[kind];
      if(!ck) continue;

      var faceGeomsJSON = {};
      if(ck.faceGeoms || (faceGeoms && faceGeoms[kind])){
        for(var i = 0; i < dirs.length; i++){
          var d = dirs[i];
          var g = null;
          if(ck.faceGeoms && ck.faceGeoms[d]){
            g = ck.faceGeoms[d];
          }else if(faceGeoms && faceGeoms[kind] && faceGeoms[kind][d]){
            g = faceGeoms[kind][d];
          }
          if(!g) continue;
          var j = serializeGeometryForJSON(g);
          if(j) faceGeomsJSON[d] = j;
        }
      }

      var mergedGeom = ck.mergedGeom || (baseGeom && baseGeom[kind]) || null;
      var mergedJSON = mergedGeom ? serializeGeometryForJSON(mergedGeom) : null;

      result[kind] = {
        faceGeoms: faceGeomsJSON,
        faceColors: ck.faceColors || {},
        faceTypes: ck.faceTypes || {},
        mergedGeom: mergedJSON,
        zen2Like: !!ck.zen2Like
      };
    }

    if(Object.keys(result).length === 0) return null;
    return result;
  }

  // восстановление customKinds из payload.customKinds
  function restoreCustomKindsFromPayload(map){
    if(!map || typeof map !== 'object') return;

    var dirs = ['top','bottom','front','back','left','right'];

    for(var kind in map){
      if(!Object.prototype.hasOwnProperty.call(map, kind)) continue;
      var data = map[kind];
      if(!data) continue;

      var faceMap = {};
      if(data.faceGeoms){
        for(var i = 0; i < dirs.length; i++){
          var d = dirs[i];
          if(!data.faceGeoms[d]) continue;
          var g = reviveGeometryFromJSON(data.faceGeoms[d]);
          if(g){
            faceMap[d] = g;
          }
        }
      }

      var merged = null;
      if(data.mergedGeom){
        merged = reviveGeometryFromJSON(data.mergedGeom);
      }

      // если merged нет – пробуем собрать из граней
      if(!merged){
        var parts = [];
        for(var dd in faceMap){
          if(!Object.prototype.hasOwnProperty.call(faceMap, dd)) continue;
          try{
            parts.push(faceMap[dd].clone());
          }catch(_){}
        }
        if(parts.length && THREE.BufferGeometryUtils && THREE.BufferGeometryUtils.mergeBufferGeometries){
          try{
            merged = THREE.BufferGeometryUtils.mergeBufferGeometries(parts, true);
            if(merged){
              merged.computeBoundingBox();
              merged.computeVertexNormals();
            }
          }catch(e){
            try{ console && console.warn && console.warn('[CustomKinds] merge faces failed', e); }catch(_){}
          }
        }
      }

      if(!merged){
        merged = new THREE.BoxGeometry(1,1,1);
      }

      baseGeom[kind] = merged;
      faceGeoms[kind] = faceMap;
      customKinds[kind] = {
        mergedGeom: merged,
        faceGeoms: faceMap,
        faceColors: data.faceColors || {},
        faceTypes: data.faceTypes || {},
        zen2Like: !!data.zen2Like
      };
    }
  }






// ===== JSON Export for backend sample =====
  function exportProjectJSON(){
    try{
      var snap = snapshotScene();
      var payload = {
        name: 'Sample project',
        snapshot: snap
      };

      // Сохраняем кастомные типы, если есть
      var customPayload = serializeCustomKindsForSnapshot(snap);
      if(customPayload){
        payload.customKinds = customPayload;
      }

      // лог для разработчика бэка
      try{
        if(window.console && console.log){
          console.log('[Export JSON payload]', payload);
        }
      }catch(_){}

      var json = JSON.stringify(payload, null, 2);
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'project-sample.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(function(){
        try{ document.body.removeChild(a); }catch(_){}
        try{ URL.revokeObjectURL(url); }catch(_){}
      }, 0);
    }catch(e){
      console.error('JSON export failed', e);
      alert('Не удалось экспортировать JSON');
    }
  }



  // ===== JSON Import / Load Scene (minimal) =====
  function importProjectJSONFromText(text){
    var data;
    try{
      data = JSON.parse(text);
    }catch(e){
      console && console.error && console.error('[Import JSON] parse error', e);
      try{ alert('Некорректный JSON файл'); }catch(_){}
      return;
    }

    // поддержка форматов:
    // 1) просто массив снапшота
    // 2) объект { snapshot: [...], customKinds?: {...} }
    var snapArr = null;
    var customPayload = null;

    if (Array.isArray(data)){
      snapArr = data;
    } else if (data && typeof data === 'object'){
      if (Array.isArray(data.snapshot)){
        snapArr = data.snapshot;
      }
      if (data.customKinds && typeof data.customKinds === 'object'){
        customPayload = data.customKinds;
      }
    }

    if (!snapArr || !snapArr.length){
      try{ alert('В JSON нет snapshot для загрузки сцены'); }catch(_){}
      return;
    }

    // остановить возможный активный таймлапс
    try{
      if (typeof replayTimer !== 'undefined' && replayTimer){
        clearInterval(replayTimer);
        replayTimer = null;
      }
      if (typeof isReplayingBuild !== 'undefined'){
        isReplayingBuild = false;
      }
      if (typeof setReplayUIBusy === 'function'){
        setReplayUIBusy(false);
      }
    }catch(e){
      console && console.warn && console.warn('[Import JSON] replay state reset error', e);
    }

    // Восстанавливаем кастомные типы, если они есть в JSON
    try{
      if(customPayload){
        restoreCustomKindsFromPayload(customPayload);
      }
    }catch(e){
      console && console.warn && console.warn('[Import JSON] restore customKinds error', e);
    }

    // восстановить сцену из снапшота
    try{
      if(typeof loadSceneFromSnapshot === 'function'){
        loadSceneFromSnapshot(snapArr);
      } else {
        console && console.error && console.error('[Import JSON] loadSceneFromSnapshot() is not available');
        try{ alert('Невозможно восстановить сцену: нет функции loadSceneFromSnapshot'); }catch(_){}
        return;
      }
    }catch(e){
      console && console.error && console.error('[Import JSON] loadSceneFromSnapshot error', e);
      try{ alert('Ошибка при восстановлении сцены из JSON'); }catch(_){}
      return;
    }

    // после загрузки считаем это новым стартовым состоянием истории
    try{
      if(typeof undoStack !== 'undefined' && typeof snapshotScene === 'function'){
        undoStack = [ snapshotScene() ];
      }
      if(typeof redoStack !== 'undefined'){
        redoStack = [];
      }
      if(typeof hasUnsavedChanges !== 'undefined'){
        hasUnsavedChanges = false;
      }
      if(typeof updateUndoRedoUI === 'function'){
        updateUndoRedoUI();
      }
    }catch(e){
      console && console.warn && console.warn('[Import JSON] undo/redo reset error', e);
    }

    try{
      msg && msg('Scene loaded from JSON', true);
    }catch(_){}
  }


  try{ window.importProjectJSONFromText = importProjectJSONFromText; }catch(_){}
// ===== GLB Export =====
  function buildExportGroup(){
    var root = new THREE.Group();
    for(var i=0;i<objects.length;i++){
      var o=objects[i];
      if(!o) continue;

      var clone = o.clone(true);
      clone.traverse(function(ch){
        if(ch.isMesh && ch.material){
          ch.material = ch.material.clone();

          if(!(ch.material instanceof THREE.MeshStandardMaterial)){
            var baseHex = (ch.material.userData && ch.material.userData.baseHex)
              ? ch.material.userData.baseHex
              : (ch.material.color
                  ? '#'+ch.material.color.getHexString()
                  : '#7D7F7D');

            var stdMat = new THREE.MeshStandardMaterial({
              color: toLinear(baseHex),
              roughness:0.85,
              metalness:0.05,
              side:THREE.DoubleSide
            });
            stdMat.userData = { baseHex: baseHex };
            ch.material = stdMat;
          }
        }
      });

      root.add(clone);
    }
    return root;
  }

  function exportGLB(){
    if(typeof THREE.GLTFExporter === 'undefined'){
      alert('GLTFExporter not found');
      return;
    }

    // Лоадер на время тяжёлого GLB экспорта (без минимального 3с)
    try { showLoader('Exporting GLB...'); } catch(_){}

    var exporter = new THREE.GLTFExporter();
    var root = buildExportGroup();

    try{
      exporter.parse(root, function(result){
        try{
          var blob = new Blob([result], {type:'model/gltf-binary'});
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = 'scene.glb';
          document.body.appendChild(a);
          a.click();
          setTimeout(function(){
            URL.revokeObjectURL(url);
            a.remove();
          }, 1000);
          msg('Scene exported to GLB', true);
        }catch(e){
          console.error(e);
          msg('Export failed', false);
        } finally {
          try { hideLoader(); } catch(_){}
        }
      }, {
        binary:true,
        onlyVisible:true,
        trs:false
      });
    }catch(e){
      console.error(e);
      msg('Export failed', false);
      try { hideLoader(); } catch(_){}
    }
  }

})(); // end main IIFE

  // Fallback: if adoptGhostFromEdited is somehow undefined in this scope, define a window-scoped version
  if (typeof window.adoptGhostFromEdited !== 'function') {
    window.adoptGhostFromEdited = function(blk){
      if(!blk || !blk.userData || !blk.userData.faces){ dbgGhost('fallback adopt: no faces'); return false; }
      try{
        var parts=[]; var dirs=['top','bottom','front','back','left','right'];
        for(var i=0;i<dirs.length;i++){ var dir=dirs[i]; var f=blk.userData.faces[dir]; if(!f || !f.geometry) continue;
          var gg=f.geometry.clone(); var mtx=new THREE.Matrix4(); mtx.compose(f.position.clone(), new THREE.Quaternion().setFromEuler(f.rotation.clone()), f.scale.clone());
          gg.applyMatrix4(mtx); parts.push(gg);
        }
        if(!parts.length){ dbgGhost('fallback adopt: no parts'); return false; }
        var merged=THREE.BufferGeometryUtils.mergeBufferGeometries(parts, true);
        merged.computeBoundingBox(); merged.computeVertexNormals();
        baseGeom[GHOST_KIND_NAME] = merged;
        faceGeoms[GHOST_KIND_NAME] = makeBoxFacesFromGeometry(merged);
        ghostType = GHOST_KIND_NAME;
        makeGhost(GHOST_KIND_NAME);
        var size=new THREE.Vector3(); merged.boundingBox.getSize(size);
        dbgGhost('adopted (fallback)', {kind: ghostType, size:[size.x,size.y,size.z]});
        return true;
      }catch(e){ dbgGhost('fallback adopt error', e); return false; }
    };
  }

;
/* Help popup open/close */
document.addEventListener('DOMContentLoaded', function(){
    try{ openHelp(); }catch(e){}  var helpBtn = document.getElementById('helpBtn');
  var helpOverlay = document.getElementById('helpOverlay');
  var helpClose = document.getElementById('helpClose');
  var helpStart = document.getElementById('helpStart');

  if(helpBtn) /* help wiring replaced */
  if(helpOverlay) helpOverlay.addEventListener('click', closeHelp);
  if(helpClose) helpClose.addEventListener('click', closeHelp);

    if(helpStart) helpStart.addEventListener('click', closeHelp);
window.addEventListener('keydown', function(e){
    if((e.ctrlKey||e.metaKey) && e.shiftKey && (e.key==='z' || e.key==='Z')){ e.preventDefault(); return; }
    if(e.key === 'Escape'){
      closeHelp();
    }
  });
});

;
function openHelp(){ document.body.classList.add('help-open'); }
function closeHelp(){ document.body.classList.remove('help-open'); }
document.addEventListener('DOMContentLoaded', function(){
    try{ openHelp(); }catch(e){}  var helpBtn = document.getElementById('helpBtn');
  var helpOverlay = document.getElementById('helpOverlay');
  var helpClose = document.getElementById('helpClose');
  var helpStart = document.getElementById('helpStart');
  if(helpBtn) helpBtn.addEventListener('click', openHelp);
  if(helpOverlay) helpOverlay.addEventListener('click', closeHelp);
  if(helpClose) helpClose.addEventListener('click', closeHelp);
    if(helpStart) helpStart.addEventListener('click', closeHelp);
window.addEventListener('keydown', function(e){ if((e.ctrlKey||e.metaKey) && e.shiftKey && (e.key==='z' || e.key==='Z')){ e.preventDefault(); return; }
    if(e.key==='Escape') closeHelp(); });
});

;
// Injected: baseline history snapshot after full load (idempotent)
window.addEventListener('load', function(){
  try {
    if (typeof undoStack !== 'undefined' && Array.isArray(undoStack) && typeof pushState === 'function') {
      if (undoStack.length === 0) {
        if (typeof redoStack === 'undefined') { window.redoStack = []; } else { redoStack = []; }
        pushState();
      }
      if (typeof updateUndoRedoUI === 'function') updateUndoRedoUI();
    }
  } catch (e) {}
});

;
(function(){
  function byId(id){ return document.getElementById(id); }
  var btn = byId('saveAsTypeBtn');
  if(btn){
    btn.addEventListener('click', function(){
      try{
        if(!window.selectedBlock){ console && console.warn('[GHOST] saveAsType: no selected block'); return; }
        var kind = (window.registerCustomKindFromBlock ? window.registerCustomKindFromBlock(window.selectedBlock, null) : null);
        if(kind){ if(window.setGhostType){ window.setGhostType(kind); } else { try{ window.ghostType = kind; makeGhost(kind); }catch(e){} } console && console.log('[GHOST] saveAsType: set ghostType', kind); }
      }catch(e){ console && console.error('[GHOST] saveAsType error', e); }
    });
  }
})();

;
(function(){
  var KEY='c3d_autosave_v3', META='c3d_autosave_meta_v3';
  var restored=false, pending=null, isDirty=false, lastHash=null;

  function debounce(fn, ms){ var t=null; return function(){ var a=arguments,s=this; clearTimeout(t); t=setTimeout(function(){ fn.apply(s,a); }, ms||250);} }
  function h(s){ var x=5381,i=s.length; while(i){ x=((x<<5)+x)^s.charCodeAt(--i);} return (x>>>0).toString(16); }

  function ready(){
    try{ return window.scene && Array.isArray(window.objects) && typeof snapshotScene==='function' && typeof restoreScene==='function'; }
    catch(e){ return false; }
  }
  function snap(){ try{ return JSON.stringify(snapshotScene()); }catch(e){ return null; } }
  function save(){
    if(!ready()) return;
    var s=snap(); if(!s) return;
    var hh=h(s); if(hh===lastHash){ isDirty=false; return; }
    try{
      localStorage.setItem(KEY,s);
      localStorage.setItem(META, JSON.stringify({ts:Date.now(),hash:hh}));
      lastHash=hh; isDirty=false;
    }catch(_){}
  }
  var scheduleSave = debounce(save, 300);

  // keyboard guards
  window.addEventListener('keydown', function(e){
    var k=(e.key||'').toLowerCase();
    if((e.ctrlKey||e.metaKey)&&k==='s'){ e.preventDefault(); scheduleSave(); return false; }
    if(k==='f5' || ((e.ctrlKey||e.metaKey)&&k==='r')){ e.preventDefault(); scheduleSave(); return false; }
    if(k==='backspace'){
      var t=e.target, tag=t&&t.tagName?t.tagName.toLowerCase():'';
      var edit=t&&(t.isContentEditable||tag==='input'||tag==='textarea');
      if(!edit){ e.preventDefault(); return false; }
    }
  }, true);
  window.addEventListener('beforeunload', function(e){ if(isDirty){ e.preventDefault(); e.returnValue=''; } });

  document.addEventListener('visibilitychange', function(){ if(document.visibilityState==='hidden') scheduleSave(); });

  // wrap pushState to mark dirty
  try{
    if(typeof window.pushState==='function' && !window.pushState.__wrapped){
      var _ps=window.pushState;
      var w=function(){ var r=_ps.apply(this,arguments); try{ isDirty=true; scheduleSave(); }catch(_){ } return r; };
      w.__wrapped=true;
      window.pushState=w;
    }
  }catch(_){}

  // disposal helper for manual & programmatic removals
  if(!window.disposeObjectRecursive){
    window.disposeObjectRecursive = function(obj){
      if(!obj) return;
      obj.traverse(function(n){
        try{
          if(n.geometry && n.geometry.dispose) n.geometry.dispose();
          var m=n.material;
          if(m){
            if(Array.isArray(m)) m.forEach(function(x){ if(x&&x.dispose) try{x.dispose();}catch(_){ } });
            else if(m.dispose) try{ m.dispose(); }catch(_){ }
          }
          if(n.texture && n.texture.dispose) try{ n.texture.dispose(); }catch(_){ }
        }catch(_){}
      });
    };
  }

  // try load pending
  try{ pending = localStorage.getItem(KEY); }catch(_){}

  function tryRestore(){
    if(restored || !pending || !ready()) return false;
    try{
      var arr = JSON.parse(pending);
      if(Array.isArray(arr)){ restoreScene(arr); restored=true; lastHash=h(pending); isDirty=false; }
    }catch(_){}
    return restored;
  }

  window.addEventListener('load', function(){
    var t=Date.now(), id=setInterval(function(){
      if(tryRestore() || (Date.now()-t>10000)){ clearInterval(id); }
    }, 300);
    setInterval(scheduleSave, 8000);
  }, {once:true});
})();


// === Palette collapse/attach disabled: palette lives in row under cubes ===
(function(){
  // old reposition / collapse logic removed
})();;