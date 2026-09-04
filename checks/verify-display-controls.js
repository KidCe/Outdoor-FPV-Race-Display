const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..');
const readProjectFile = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
const firmware = readProjectFile('wled/usermods/fpv_race_display/fpv_race_display.cpp');
const rendererHeader = readProjectFile('wled/usermods/fpv_race_display/fpv_renderer.h');
const rendererSource = readProjectFile('wled/usermods/fpv_race_display/fpv_renderer.cpp');
const sceneHeader = readProjectFile('wled/usermods/fpv_race_display/fpv_scene.h');
const webUi = readProjectFile('web/fpv-race-wled-80x80.html');

for (const match of webUi.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);

function loadWebUiRuntime() {
  const elements = new Map();
  const context2d = {fillRect(){},strokeRect(){},clearRect(){},getImageData(){return {data:new Uint8ClampedArray(0)}}};
  const makeElement = (id = '') => ({id,value:'',type:'',checked:false,hidden:false,disabled:false,textContent:'',className:'',style:{},classList:{toggle(){}},append(){},click(){},getContext(){return context2d},toBlob(){}});
  for (const match of webUi.matchAll(/<(input|select|output|canvas|button|div|pre|span)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [,tag,attributes,id] = match, element = makeElement(id);
    element.type = attributes.match(/\btype="([^"]+)"/)?.[1] || (tag === 'select' ? 'select-one' : '');
    element.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] || '';
    element.checked = /\bchecked\b/.test(attributes);
    if (tag === 'select') {
      const body = webUi.match(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/select>`))?.[1] || '';
      const selected = body.match(/<option[^>]*value="([^"]*)"[^>]*selected/) || body.match(/<option[^>]*value="([^"]*)"/);
      if (selected) element.value = selected[1];
    }
    elements.set(id, element);
  }
  for (let index = 0; index < 8; index++) {
    for (const [prefix,value,type] of [['ch', ['R1','R2','F2','F4','R7','R8','L6','L7'][index], 'text'],['cc', ['#ffffff','#ff0000','#ffff00','#00ff00','#0000ff','#ff00ff','#ff6600','#00ffff'][index], 'color'],['pn', '', 'text'],['pc', '#ffffff', 'color'],['pe', 'none', 'select-one']]) {
      const element = makeElement(`${prefix}${index}`); element.value = value; element.type = type; elements.set(element.id, element);
    }
  }
  const document = {getElementById:id=>elements.get(id),createElement:()=>makeElement(),body:{classList:{toggle(){}}},documentElement:{},title:''};
  const sandbox = {document,localStorage:{getItem(){return null},setItem(){}},navigator:{},console,TextEncoder,TextDecoder,Uint8Array,Uint8ClampedArray,Blob:class {},URL:{createObjectURL(){return ''},revokeObjectURL(){}},setTimeout(){return 0},clearTimeout(){},setInterval(){return 0},atob:value=>Buffer.from(value,'base64').toString('binary')};
  vm.createContext(sandbox);
  const scripts = [...webUi.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]);
  vm.runInContext(scripts[0], sandbox);
  return sandbox;
}

const webRuntime = loadWebUiRuntime();
const semanticSchemas = vm.runInContext(`['inward','upward','right-single','right-double'].map(frame=>{document.getElementById('headerFrame').value=frame;const schema=buildLayoutSchema();return {frame,hash:schema.schemaHash,nodes:schema.nodes.length,bindings:[...new Set(schema.nodes.map(node=>node.bind).filter(Boolean))]}})`, webRuntime);
const semanticHashes = new Set(semanticSchemas.map(schema => schema.hash));
const semanticBindings = new Set(semanticSchemas[0].bindings);
if (process.env.FPV_SCHEMA_OUTPUT) {
  const schema = vm.runInContext(`document.getElementById('headerFrame').value='inward';buildLayoutSchema()`, webRuntime);
  fs.writeFileSync(process.env.FPV_SCHEMA_OUTPUT, JSON.stringify(schema, null, 2) + '\n');
}

const checks = [
  [firmware.includes('strip.fill(_scene.background)'), 'exclusive mode must clear the final WLED framebuffer'],
  [firmware.includes('strip.setPixelColor(index, color_fade(strip.getPixelColorNoMap(index), retained, true))'), 'overlay mode must dim the final WLED framebuffer'],
  [firmware.includes('frame.begin') && firmware.includes('frame.chunk') && firmware.includes('BusManager::getPixelColor(strip.getMappedPixelIndex(index))'), 'firmware must expose mapped HUB75 frame readback'],
  [firmware.includes('command.containsKey("brightness")'), 'state protocol must accept brightness'],
  [firmware.includes('command.containsKey("backgroundEffect")'), 'state protocol must accept background effect visibility'],
  [rendererHeader.includes('bool drawBackground'), 'renderer must allow the module to own background composition'],
  [webUi.includes('id="displayBrightness"') && webUi.includes('value="15"'), 'WebUI brightness must default to 15%'],
  [webUi.includes('id="backgroundEffect"') && webUi.includes('value="0"'), 'WebUI background effect must default to black'],
  [webUi.includes("fields.brightness=+$('displayBrightness').value"), 'live state must transmit brightness'],
  [webUi.includes("fields.backgroundEffect=+$('backgroundEffect').value"), 'live state must transmit background effect visibility'],
  [webUi.includes('id="readFrame">Read displayed pixels</button>') && webUi.includes("sendCommand('frame.chunk'") && webUi.includes('checksumRgb(pixels)'), 'WebUI must reconstruct and verify displayed RGB pixels'],
  [webUi.includes("sendCommand('activate',{on:false}"), 'disabling live output must release the overlay'],
  [webUi.includes('id="advancedMode" type="checkbox"> Special mode') && webUi.includes('class="pilot-effect advanced-only"') && !webUi.includes('> Advanced mode</label>'), 'special mode must discreetly reveal pilot effect controls'],
  [webUi.indexOf('class="special-mode-footer"') > webUi.indexOf('<strong>Generated text</strong>'), 'special mode control must be placed at the bottom of the page'],
  [webUi.includes("$('advancedMode').checked?$(`pe${index}`).value:'none'"), 'advanced effects must be inactive when advanced mode is off'],
  [webUi.includes("drawChevron(right-radius*t-chevron*(radius+2)*t+motion,d)"), 'directional chevron preview must draw on both sides'],
  [webUi.includes("arrow(`${prefix}R${i}`,b.right-g.radius-i*(g.radius+2)*g.thickness,pointsRight,motion)"), 'directional arrow schema must include the right side'],
  [webUi.includes('value="inward" selected>Current heat · Inward arrows') && webUi.includes('value="upward">Staged · Upward arrows') && webUi.includes('value="right-single">Next up · Right arrows') && webUi.includes('value="right-double">Next +2 · Double right arrows'), 'header options must map the four race states to arrows'],
  [webUi.includes('function drawMatrixPixel(') && webUi.includes('drawMatrixPixel(ctx,px+sx,py+sy') && webUi.includes('drawMatrixPixel(ctx,px,py,color,W,H,z)'), 'all preview graphics must use the shared matrix-pixel renderer'],
  [webUi.includes('function headerFrameExtent(frame,paddingX,radius,thickness,count)') && webUi.includes('const arrowGap=Math.max(1,paddingX)') && webUi.includes("motionReserve=frame==='upward'?0:1") && webUi.includes('headerFrameExtent(frame,paddingX,chevronRadius,thickness,chevronCount)') && webUi.includes('headerFrameExtent(frame,padX,radius,thickness,count)'), 'arrow layout must preserve a one-pixel text gap throughout motion'],
  [webUi.includes('rightX=right-t+1-'), 'inward and outward right arrows must mirror the left-side pixel bounds'],
  [webUi.includes("frame==='upward'"), 'staged heat must render upward chevrons'],
  [webUi.includes("Math.floor((textHeight-thickness)/2)") && webUi.includes("Math.floor((metrics.height-thickness)/2)"), 'chevron height must follow text height'],
  [webUi.includes("motion=pointsRight?'right':'left'") && webUi.includes("bind,'up'"), 'arrow schemas must encode directional motion'],
  [webUi.includes("const SEMANTIC_HEADER_FRAMES={inward:{binding:'headerCurrent'") && webUi.includes("upward:{binding:'headerStaged'") && webUi.includes("'right-single':{binding:'headerNext'") && webUi.includes("'right-double':{binding:'headerNext2'"), 'all race status arrow groups must have stable runtime bindings'],
  [webUi.includes("g=schemaGeometry(semantic?'right-double':selectedFrame)") && webUi.includes('for(const [frame,definition] of Object.entries(SEMANTIC_HEADER_FRAMES))addFrameNodes'), 'semantic race states must share one canonical schema geometry'],
  [webUi.includes('visible:definition===semantic') && sceneHeader.includes('bool hasVisible = false') && firmware.includes('source.containsKey("visible")') && rendererSource.includes('value->hasVisible && !value->visible'), 'state updates must select preinstalled arrow groups through runtime visibility'],
  [webUi.includes('async function sendDisplayState(schema)') && webUi.includes('chunkSize=8') && webUi.includes('replace:first'), 'live state must be split into bounded patches for reliable USB transport'],
  [semanticHashes.size === 1, 'Current, Staged, Next Up, and Next +2 must produce the same schema hash'],
  [semanticSchemas.every(schema => schema.nodes === 29 && schema.nodes <= 40) && ['headerCurrent','headerStaged','headerNext','headerNext2'].every(binding => semanticBindings.has(binding)), 'the shared semantic schema must contain all four arrow groups within the node limit'],
  [sceneHeader.includes('enum class Motion') && sceneHeader.includes('parseMotion'), 'schema interface must parse generic node motion'],
  [rendererSource.includes('motionOffset') && rendererSource.includes('.motion != Motion::None'), 'ESP32 renderer must animate motion nodes without controller updates'],
  [webUi.includes('id="channelColors">Color Channels</button>') && !webUi.includes('Color channels by band'), 'channel color action must use the requested label'],
  [webUi.includes("L6:'#ff6600'") && webUi.includes("L7:'#00ffff'") && webUi.includes("R1:'#ffffff'") && webUi.includes("R2:'#ff0000'") && webUi.includes("F2:'#ffff00'") && webUi.includes("F4:'#00ff00'") && webUi.includes("R7:'#0000ff'") && webUi.includes("R8:'#ff00ff'"), 'channel color mapping must match the reference card'],
  [webUi.includes('id="pitch" type="number" value="5"') && webUi.includes('id="zoom" type="number" value="6"') && webUi.includes("'80x80':[80,80,5]"), 'first-run display geometry must match the supplied settings'],
  [webUi.includes('id="titleText" value=""') && webUi.includes('<option value="double" selected>Overline + underline</option>') && webUi.includes('<option value="inward" selected>Current heat · Inward arrows</option>'), 'first-run header settings must match the supplied settings'],
  [webUi.includes('id="pilotWidth" type="number" value="15"') && webUi.includes('id="headerGap" type="number" value="2"') && webUi.includes('id="previewScaleValue" for="previewScale">55%</output>') && webUi.includes('id="previewScale" type="range" min="25" max="400" step="10" value="55"'), 'first-run layout and preview settings must match the supplied settings'],
  [webUi.includes('id="displayBrightnessValue" for="displayBrightness">15%</output>') && webUi.includes('id="displayBrightness" type="range" min="0" max="100" step="1" value="15"'), 'first-run brightness must match the supplied settings'],
  [webUi.includes("names=['Relax_Max','king_joshy','TilenFPV','Nivz','GiantRabbit','Pastis','KEMFPV','BuckZap']") && webUi.includes("channelColors=['#ffffff','#ff0000','#ffff00','#00ff00','#0000ff','#ff00ff','#ff6600','#00ffff']") && webUi.includes('value="${channelColors[i]}"'), 'first-run race entries and channel colors must match the supplied settings'],
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(failures.map(message => `FAIL: ${message}`).join('\n'));
  process.exit(1);
}

console.log('FPV display controls verified.');
