// 页面指示器 / upload_image / gif_creator / 空闲释放
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, setup, sleep, userPage } from './harness.mjs';

const t = await setup();
const { call, js, refOf, expect } = t;
// 指示器是彩色渐变，按饱和度判断；白色页面边缘的饱和度接近 0
const isColorful = (rgb) => Math.max(...rgb) - Math.min(...rgb) > 60;
try {
  const tabId = JSON.parse((await call('tabs_context_mcp', { createIfEmpty: true })).t).availableTabs[0].tabId;
  await call('navigate', { tabId, url: 'http://127.0.0.1:18801/test.html' });
  const user = await userPage('test.html');
  await sleep(500);
  expect(isColorful(await user.edgeColor()), '执行工具时页面显示彩色渐变边框');

  const vp = JSON.parse(await js(tabId, '({ w: innerWidth, h: innerHeight })'));
  const shot = await call('computer', { tabId, action: 'screenshot' });
  const [sw, sh] = shot.t.match(/\((\d+)x(\d+), jpeg\)/).slice(1).map(Number);
  const toShot = (x, y) => [Math.round(x * sw / vp.w), Math.round(y * sh / vp.h)];

  // 指示器不挡页面：原来停止按钮所在的底部中间，点到的是页面自己的元素
  const atBottom = await user.evaluate(`document.elementFromPoint(${vp.w / 2}, ${vp.h - 36})?.closest('[data-bb-indicator]') ? 'indicator' : 'page'`);
  expect(atBottom === 'page', '页面上没有停止按钮，指示器不拦截点击');

  // upload_image：截图 → 文件输入框 / 拖放区
  const imageId = (await call('computer', { tabId, action: 'screenshot' })).t.match(/ID: (ss_\w+)/)[1];
  const fileRef = refOf((await call('find', { tabId, query: 'file' })).t, /\(file\)/);
  await call('upload_image', { tabId, imageId, ref: fileRef, filename: 'shot.jpg' });
  expect((await js(tabId, `document.getElementById('out').textContent`)) === 'files:shot.jpg', 'upload_image 上传到文件输入框');
  const dz = JSON.parse(await js(tabId, `(() => { const r = document.getElementById('drop').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`));
  await call('upload_image', { tabId, imageId, coordinate: toShot(dz.x, dz.y) });
  expect(/^dropped:image\.jpg\/image\/jpeg\/\d+$/.test(await js(tabId, `document.getElementById('out').textContent`)), 'upload_image 拖放到坐标处');
  await call('upload_image', { tabId, imageId: 'ss_nope', ref: fileRef }, { expectError: true });

  // gif_creator：录制 → 保存到本地 / 拖放到页面
  await call('gif_creator', { tabId, action: 'export', download: true }, { expectError: true });
  await call('gif_creator', { tabId, action: 'start_recording' });
  await call('computer', { tabId, action: 'screenshot' });
  await call('computer', { tabId, action: 'left_click', ref: refOf((await call('find', { tabId, query: '可点击卡片' })).t, /ref_/) });
  await call('computer', { tabId, action: 'left_click', ref: refOf((await call('find', { tabId, query: '备注' })).t, /ref_/) });
  await call('computer', { tabId, action: 'type', text: 'recording demo' });
  await call('computer', { tabId, action: 'scroll', coordinate: [200, 200], scroll_direction: 'down', scroll_amount: 2 });
  await call('navigate', { tabId, url: 'http://127.0.0.1:18801/test.html?after' });
  await call('computer', { tabId, action: 'screenshot' });
  const frames = Number((await call('gif_creator', { tabId, action: 'stop_recording' })).t.match(/Captured (\d+) frame/)[1]);
  expect(frames >= 8, `录制到 ${frames} 帧`);
  const gifPath = join(HERE, 'out/demo.gif');
  rmSync(gifPath, { force: true });
  const ex = await call('gif_creator', { tabId, action: 'export', download: true, filename: gifPath });
  const gif = existsSync(gifPath) ? readFileSync(gifPath) : Buffer.alloc(0);
  expect(gif.subarray(0, 6).toString() === 'GIF89a' && ex.t.includes(gifPath), `GIF 已保存（${Math.round(gif.length / 1024)}KB）`);
  rmSync(join(HERE, 'out'), { recursive: true, force: true });
  await call('gif_creator', { tabId, action: 'start_recording' });
  await call('computer', { tabId, action: 'screenshot' });
  await call('computer', { tabId, action: 'left_click', ref: refOf((await call('find', { tabId, query: '可点击卡片' })).t, /ref_/) });
  await call('gif_creator', { tabId, action: 'stop_recording' });
  await call('computer', { tabId, action: 'screenshot' });
  await call('gif_creator', { tabId, action: 'export', coordinate: toShot(dz.x, dz.y), filename: 'clip.gif' });
  expect(/^dropped:clip\.gif\/image\/gif\/\d+$/.test(await js(tabId, `document.getElementById('out').textContent`)), 'GIF 拖放导出到页面');

  // 空闲 20 秒后释放：指示器消失，再次调用自动重新附加
  user.close();
  const user2 = await userPage('test.html');
  console.log('  等待 22 秒空闲释放…');
  await sleep(22_000);
  expect(!isColorful(await user2.edgeColor()), '空闲 20 秒后指示器消失');
  expect(!(await call('read_page', { tabId, filter: 'interactive', max_chars: 200 }, { quiet: true })).isError, '释放后再次调用自动重新附加');
  user2.close();
} catch (e) {
  t.fail(e);
}
await t.done();
