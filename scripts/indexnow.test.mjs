import {test} from 'node:test';
import assert from 'node:assert/strict';
import {changedUrls,waitForManifest} from './indexnow.mjs';
test('IndexNow sends only added, changed and removed pages',()=>{assert.deepEqual(changedUrls({pages:{a:'1',b:'2',c:'3'}},{pages:{a:'1',b:'4',d:'5'}}),['b','c','d']);assert.deepEqual(changedUrls({pages:{a:'1'}},{pages:{a:'1'}}),[]);});

test('deployment propagation retries empty and stale responses, then succeeds',async()=>{
 let calls=0; const expected={pages:{a:'new'}};
 await waitForManifest(expected,async()=>{calls++;if(calls===1)throw new SyntaxError('empty JSON');return calls===2?{pages:{a:'old'}}:expected;},async()=>{});
 assert.equal(calls,3);
});
test('does not submit a deployment that never becomes ready',async()=>{
 await assert.rejects(waitForManifest({pages:{}},async()=>({pages:{a:'old'}}),async()=>{}),/no notification sent/);
});
