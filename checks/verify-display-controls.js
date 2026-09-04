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

const checks = [
  [firmware.includes('strip.fill(_scene.background)'), 'exclusive mode must clear the final WLED framebuffer'],
  [firmware.includes('strip.setPixelColor(index, color_fade(strip.getPixelColorNoMap(index), retained, true))'), 'overlay mode must dim the final WLED framebuffer'],
  [firmware.includes('frame.begin') && firmware.includes('frame.chunk') && firmware.includes('BusManager::getPixelColor(strip.getMappedPixelIndex(index))'), 'firmware must expose mapped HUB75 frame readback'],
  [firmware.includes('command.containsKey("brightness")'), 'state protocol must accept brightness'],
  [firmware.includes('command.containsKey("backgroundEffect")'), 'state protocol must accept background effect visibility'],
  [rendererHeader.includes('bool drawBackground'), 'renderer must allow the module to own background composition'],
  [webUi.includes('id="displayBrightness"') && webUi.includes('value="15"'), 'WebUI brightness must default to 15%'],
  [webUi.includes('id="backgroundEffect"') && webUi.includes('value="0"'), 'WebUI background effect must default to black'],
  [webUi.includes('brightness:+$(\'displayBrightness\').value'), 'live state must transmit brightness'],
  [webUi.includes('backgroundEffect:+$(\'backgroundEffect\').value'), 'live state must transmit background effect visibility'],
  [webUi.includes('id="readFrame">Read displayed pixels</button>') && webUi.includes("sendCommand('frame.chunk'") && webUi.includes('checksumRgb(pixels)'), 'WebUI must reconstruct and verify displayed RGB pixels'],
  [webUi.includes("sendCommand('activate',{on:false}"), 'disabling live output must release the overlay'],
  [webUi.includes('id="advancedMode" type="checkbox"> Special mode') && webUi.includes('class="pilot-effect advanced-only"') && !webUi.includes('> Advanced mode</label>'), 'special mode must discreetly reveal pilot effect controls'],
  [webUi.indexOf('class="special-mode-footer"') > webUi.indexOf('<strong>Generated text</strong>'), 'special mode control must be placed at the bottom of the page'],
  [webUi.includes("$('advancedMode').checked?$(`pe${index}`).value:'none'"), 'advanced effects must be inactive when advanced mode is off'],
  [webUi.includes("drawChevron(right-radius*t-chevron*(radius+2)*t+motion,d)"), 'directional chevron preview must draw on both sides'],
  [webUi.includes("chevron(`chevR${i}`,b.right-g.radius-i*(g.radius+2)*g.thickness,pointsRight,motion)"), 'directional chevron schema must include the right side'],
  [webUi.includes('value="inward" selected>Current heat · Inward arrows') && webUi.includes('value="upward">Staged · Upward arrows') && webUi.includes('value="right-single">Next up · Right arrows') && webUi.includes('value="right-double">Next +2 · Double right arrows'), 'header options must map the four race states to arrows'],
  [webUi.includes('function drawMatrixPixel(') && webUi.includes('drawMatrixPixel(ctx,px+sx,py+sy') && webUi.includes('drawMatrixPixel(ctx,px,py,color,W,H,z)'), 'all preview graphics must use the shared matrix-pixel renderer'],
  [webUi.includes('function headerFrameExtent(frame,paddingX,radius,thickness,count)') && webUi.includes('const arrowGap=Math.max(1,paddingX)') && webUi.includes("motionReserve=frame==='upward'?0:1") && webUi.includes('headerFrameExtent(frame,paddingX,chevronRadius,thickness,chevronCount)') && webUi.includes('headerFrameExtent(frame,padX,radius,thickness,count)'), 'arrow layout must preserve a one-pixel text gap throughout motion'],
  [webUi.includes('rightX=right-t+1-'), 'inward and outward right arrows must mirror the left-side pixel bounds'],
  [webUi.includes("frame==='upward'"), 'staged heat must render upward chevrons'],
  [webUi.includes("Math.floor((textHeight-thickness)/2)") && webUi.includes("Math.floor((metrics.height-thickness)/2)"), 'chevron height must follow text height'],
  [webUi.includes("motion=pointsRight?'right':'left'") && webUi.includes("decorBind,'up'"), 'chevron schemas must encode directional motion'],
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
