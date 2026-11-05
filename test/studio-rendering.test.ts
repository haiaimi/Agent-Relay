import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
// @ts-expect-error Read-only local configuration discovery is JavaScript.
import {renderingProfile} from '../scripts/studio-rendering-profile.mjs';
test('rendering discovery distinguishes no-receiver config from unknown/legacy and never claims runtime acceptance',()=>{
  const root=mkdtempSync(join(tmpdir(),'render-contract-')),project=join(root,'project');
  try{
    assert.equal(renderingProfile(root).configuredDefault,'unknown');mkdirSync(join(project,'config'),{recursive:true});mkdirSync(join(project,'tools'));
    const preset=join(project,'config/default_voxel_flags.json'),launcher=join(project,'tools/run_main.py');
    writeFileSync(preset,JSON.stringify(['--surfel-voxel-cache','--surfel-gpu-hierarchy']));writeFileSync(launcher,'parser.add_argument("--gi-preset", choices=["voxel", "lightmap"], default="voxel")');
    const report=renderingProfile(root);assert.equal(report.configuredDefault,'voxel-no-receiver');assert.equal(report.runtimeVerified,false);assert.equal(report.evidence.length,2);assert.match(report.evidence[0].sha256,/^[a-f0-9]{64}$/);
    writeFileSync(launcher,'parser.add_argument("--gi-preset", default="lightmap")');assert.equal(renderingProfile(root).configuredDefault,'unknown');
    writeFileSync(preset,'corrupt');assert.equal(renderingProfile(root).configuredDefault,'unknown');assert.ok(renderingProfile(root).error);
  }finally{rmSync(root,{recursive:true,force:true});}
});
