import {test} from 'node:test';
import assert from 'node:assert/strict';
import {changedUrls} from './indexnow.mjs';
test('IndexNow sends only added, changed and removed pages',()=>{assert.deepEqual(changedUrls({pages:{a:'1',b:'2',c:'3'}},{pages:{a:'1',b:'4',d:'5'}}),['b','c','d']);assert.deepEqual(changedUrls({pages:{a:'1'}},{pages:{a:'1'}}),[]);});
