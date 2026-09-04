const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..');
const readProjectFile = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
const firmware = readProjectFile('wled/usermods/fpv_race_display/fpv_race_display.cpp');
const rendererHeader = readProjectFile('wled/usermods/fpv_race_display/fpv_renderer.h');
const webUi = readProjectFile('web/fpv-race-wled-80x80.html');

for (const match of webUi.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);

const checks = [
  [firmware.includes('segment.fill(_scene.background)'), 'exclusive mode must clear the complete WLED segment'],
  [firmware.includes('segment.fadeToBlackBy'), 'overlay mode must dim the complete WLED segment'],
  [firmware.includes('command.containsKey("brightness")'), 'state protocol must accept brightness'],
  [firmware.includes('command.containsKey("backgroundEffect")'), 'state protocol must accept background effect visibility'],
  [rendererHeader.includes('bool drawBackground'), 'renderer must allow the module to own background composition'],
  [webUi.includes('id="displayBrightness"') && webUi.includes('value="50"'), 'WebUI brightness must default to 50%'],
  [webUi.includes('id="backgroundEffect"') && webUi.includes('value="0"'), 'WebUI background effect must default to black'],
  [webUi.includes('brightness:+$(\'displayBrightness\').value'), 'live state must transmit brightness'],
  [webUi.includes('backgroundEffect:+$(\'backgroundEffect\').value'), 'live state must transmit background effect visibility'],
  [webUi.includes("sendCommand('activate',{on:false}"), 'disabling live output must release the overlay'],
  [webUi.includes('id="advancedMode"') && webUi.includes('class="pilot-effect advanced-only"'), 'advanced mode must hide pilot effect controls by default'],
  [webUi.includes("$('advancedMode').checked?$(`pe${index}`).value:'none'"), 'advanced effects must be inactive when advanced mode is off'],
  [webUi.includes("if(count===2)for(let chevron=0;chevron<count;chevron++)") && webUi.includes("drawChevron(right-radius*t-chevron*(radius+2)*t,d)"), 'double chevron preview must draw on both sides'],
  [webUi.includes("chevron(`chevR${i}`,b.right-g.radius-i*(g.radius+2)*g.thickness,pointsRight)"), 'double chevron schema must include the right side'],
  [webUi.includes('id="channelColors">Color Channels</button>') && !webUi.includes('Color channels by band'), 'channel color action must use the requested label'],
  [webUi.includes("L6:'#ff6600'") && webUi.includes("L7:'#00ffff'") && webUi.includes("R1:'#ffffff'") && webUi.includes("R2:'#ff0000'") && webUi.includes("F2:'#ffff00'") && webUi.includes("F4:'#00ff00'") && webUi.includes("R7:'#0000ff'") && webUi.includes("R8:'#ff00ff'"), 'channel color mapping must match the reference card'],
];

const failures = checks.filter(([passed]) => !passed).map(([, message]) => message);
if (failures.length) {
  console.error(failures.map(message => `FAIL: ${message}`).join('\n'));
  process.exit(1);
}

console.log('FPV display controls verified.');
