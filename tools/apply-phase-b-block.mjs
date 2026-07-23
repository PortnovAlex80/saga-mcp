#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function abs(file) {
  return path.join(root, file);
}

function writeText(file, text) {
  mkdirSync(path.dirname(abs(file)), { recursive: true });
  writeFileSync(abs(file), text, 'utf8');
}

function decode(value) {
  return Buffer.from(value, 'base64').toString('utf8');
}

function countOccurrences(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = source.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function replaceOnce(file, search, replacement) {
  const source = readFileSync(abs(file), 'utf8');
  const count = countOccurrences(source, search);
  if (count !== 1) {
    throw new Error(`${file}: expected exactly one anchor, found ${count}: ${search.slice(0, 100)}`);
  }
  writeText(file, source.replace(search, replacement));
}

function replaceBetween(file, start, end, replacement) {
  const source = readFileSync(abs(file), 'utf8');
  const startCount = countOccurrences(source, start);
  const endCount = countOccurrences(source, end);
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(`${file}: non-unique range anchors start=${startCount} end=${endCount}`);
  }
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`${file}: end anchor precedes/misses start`);
  writeText(file, source.slice(0, from) + replacement + source.slice(to));
}

// tracker-view: preserve all HTML/routes/model-selector behavior, replace only
// board reads, engine administration and direct runtime config reads.
replaceOnce(
  'tracker-view/tracker-view.mjs',
  decode('aW1wb3J0IHsgZ2V0RGIgYXMgZW5zdXJlU2FnYURiLCBjbG9zZURiIGFzIGNsb3NlU2FnYURiIH0gZnJvbSAnLi4vZGlzdC9kYi5qcyc7'),
  decode('aW1wb3J0IHsgZ2V0RGIgYXMgZW5zdXJlU2FnYURiLCBjbG9zZURiIGFzIGNsb3NlU2FnYURiIH0gZnJvbSAnLi4vZGlzdC9kYi5qcyc7CmltcG9ydCB7IGNyZWF0ZVNhZ2EyQXBwbGljYXRpb24gfSBmcm9tICcuLi9kaXN0L2FwcC9jb21wb3NpdGlvbi1yb290LmpzJzsKaW1wb3J0IHsgbG9hZFNhZ2FSdW50aW1lQ29uZmlnIH0gZnJvbSAnLi4vZGlzdC9ydW50aW1lL3NhZ2EtcnVudGltZS1jb25maWcuanMnOw=='),
);
replaceBetween(
  'tracker-view/tracker-view.mjs',
  decode('Ly8g0J7QlNCY0J0g0LjRgdGC0L7Rh9C90LjQuiDQtNCw0L3QvdGL0YUg4oCUINC+0LHRidCw0Y8g0JHQlCBzYWdhLW1jcC4g0KLQsCDQttC1LCDRh9GC0L4gc2FnYS1NQ1At0YHQtdGA0LLQtdGALg=='),
  decode('Cgpjb25zdCBDT0xTID0gWw=='),
  decode('Ly8g0J7QlNCY0J0g0LjRgdGC0L7Rh9C90LjQuiDQutC+0L3RhNC40LPRg9GA0LDRhtC40Lgg0LTQu9GPIHRyYWNrZXIvcnVudGltZSBhZGFwdGVycy4KY29uc3QgcnVudGltZUNvbmZpZyA9IGxvYWRTYWdhUnVudGltZUNvbmZpZyhwcm9jZXNzLmVudik7CmNvbnN0IERCX1BBVEggPSBydW50aW1lQ29uZmlnLmRiUGF0aDsKCi8vINCk0LDQudC7IHNhZ2EuZGIg0YHQvtC30LTQsNGR0YLRgdGPINC70LXQvdC40LLQviBNQ1At0YHQtdGA0LLQtdGA0L7QvCDQv9GA0Lgg0L/QtdGA0LLQvtC8INCy0YvQt9C+0LLQtSDQuNC90YHRgtGA0YPQvNC10L3RgtCwLgovLyDQldGB0LvQuCB0cmFja2VyLXZpZXcg0LfQsNC/0YPRgdC60LDQtdGC0YHRjyDQv9C10YDQstGL0LwsINC40L3QuNGG0LjQsNC70LjQt9C40YDRg9C10Lwg0YLRgyDQttC1IHNjaGVtYS9taWdyYXRpb25zLgppZiAoIWV4aXN0c1N5bmMoREJfUEFUSCkpIHsKICB0cnkgewogICAgY29uc3QgZGlyID0gcGF0aC5kaXJuYW1lKERCX1BBVEgpOwogICAgaWYgKCFleGlzdHNTeW5jKGRpcikpIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pOwogICAgZW5zdXJlU2FnYURiKCk7CiAgICBjbG9zZVNhZ2FEYigpOwogICAgY29uc29sZS5sb2coYHNhZ2EuZGIg0L3QtSDRgdGD0YnQtdGB0YLQstC+0LLQsNC7IOKAlCDQuNC90LjRhtC40LDQu9C40LfQuNGA0L7QstCw0L06ICR7REJfUEFUSH1gKTsKICB9IGNhdGNoIChlKSB7CiAgICBjb25zb2xlLmVycm9yKGDQndC1INGD0LTQsNC70L7RgdGMINC40L3QuNGG0LjQsNC70LjQt9C40YDQvtCy0LDRgtGMIHNhZ2EuZGIg0L/QviDQv9GD0YLQuCAke0RCX1BBVEh9OiAke2UubWVzc2FnZX1gKTsKICAgIHByb2Nlc3MuZXhpdCgxKTsKICB9Cn0KCmNvbnN0IFBPUlQgPSBydW50aW1lQ29uZmlnLnRyYWNrZXJQb3J0Owpjb25zdCBQSURfRklMRSA9IHBhdGguam9pbihfX2Rpcm5hbWUsICcudHJhY2tlci12aWV3LnBpZCcpOwpjb25zdCBSRUxPQURfU0VDID0gcnVudGltZUNvbmZpZy50cmFja2VyUmVsb2FkU2VjOwpjb25zdCBzYWdhQXBwbGljYXRpb24gPSBjcmVhdGVTYWdhMkFwcGxpY2F0aW9uKHByb2Nlc3MuZW52KTs='),
);
replaceBetween(
  'tracker-view/tracker-view.mjs',
  decode('Ly8g0JLRgdC1IHNhZ2Et0L/RgNC+0LXQutGC0YsgKGlkLCBuYW1lLCBzdGF0dXMpICsg0YHRh9GR0YLRh9C40LrQuCDQt9Cw0LTQsNGHLg=='),
  decode('ZnVuY3Rpb24gZXNjKHMpew=='),
  decode('Ly8g0JLRgdC1IHNhZ2Et0L/RgNC+0LXQutGC0Ysg0Lgg0LrQsNC90LHQsNC9INGH0LjRgtCw0Y7RgtGB0Y8g0YfQtdGA0LXQtyDRgdGC0LDQsdC40LvRjNC90YPRjiBhcHBsaWNhdGlvbiBwcm9qZWN0aW9uLgpmdW5jdGlvbiBsaXN0UHJvamVjdHMoKSB7CiAgcmV0dXJuIHNhZ2FBcHBsaWNhdGlvbi5saXN0UHJvamVjdHMoKTsKfQoKZnVuY3Rpb24gZ2V0UHJvamVjdChpZCkgewogIHJldHVybiB3aXRoRGIoZGIgPT4gZGIucHJlcGFyZSgnU0VMRUNUICogRlJPTSBwcm9qZWN0cyBXSEVSRSBpZD0/JykuZ2V0KGlkKSk7Cn0KCmZ1bmN0aW9uIGxvYWRCb2FyZChwcm9qZWN0SWQpIHsKICByZXR1cm4gc2FnYUFwcGxpY2F0aW9uLmxvYWRQcm9qZWN0Qm9hcmQoTnVtYmVyKHByb2plY3RJZCkpOwp9Cgo='),
);
replaceBetween(
  'tracker-view/tracker-view.mjs',
  decode('Y29uc3QgYm9hcmRSdW5uZXIgPSBjcmVhdGVDbGF1ZGVCb2FyZFJ1bm5lcih7'),
  decode('CgovLyDQndCw0LnRgtC4INGE0LjQt9C40YfQtdGB0LrQuNC5INC/0YPRgtGMINC6IC5tZCDRhNCw0LnQu9GDINCw0YDRgtC10YTQsNC60YLQsC4='),
  decode('Y29uc3QgYm9hcmRSdW5uZXIgPSBjcmVhdGVDbGF1ZGVCb2FyZFJ1bm5lcih7CiAgY2xhaW1UYXNrOiBhcmdzID0+IGRpc3BhdGNoZXJIYW5kbGVycy53b3JrZXJfbmV4dChhcmdzKSwKICBnZXRQcm9qZWN0OiBwcm9qZWN0SWQgPT4gd2l0aERiKGRiID0+IGRiLnByZXBhcmUoJ1NFTEVDVCAqIEZST00gcHJvamVjdHMgV0hFUkUgaWQ9PycpLmdldChwcm9qZWN0SWQpKSwKICBnZXRUYXNrU3RhdGU6IGdldFJ1bm5lclRhc2tTdGF0ZSwKICByZWNvdmVyQXNzaWdubWVudDogcmVjb3ZlclJ1bm5lckFzc2lnbm1lbnQsCiAgcmVzb2x2ZVdvcmtzcGFjZTogcmVzb2x2ZVByb2plY3RXb3Jrc3BhY2UsCiAgZGJQYXRoOiBydW50aW1lQ29uZmlnLmRiUGF0aCwKICBzYWdhRW50cnk6IHBhdGguam9pbihfX2Rpcm5hbWUsICcuLicsICdkaXN0JywgJ2luZGV4LmpzJyksCiAgc2FnYVNraWxsUm9vdDogcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uJywgJ3NraWxscycpLAogIGNsYXVkZVBhdGg6IHJ1bnRpbWVDb25maWcuY2xhdWRlUGF0aCwKICBsbXN0dWRpb0Jhc2VVcmw6IHJ1bnRpbWVDb25maWcubG1TdHVkaW9VcmwsCn0pOw=='),
);
replaceBetween(
  'tracker-view/tracker-view.mjs',
  decode('ICAgICAgLy8gU3Bhd24g0LTQstC40LbQutCwLCDQtdGB0LvQuCDQstC60LvRjtGH0ZHQvSB2MyDRgNC10LbQuNC8Lg=='),
  decode('CgogICAgICByZXNwb25kSnNvbihyZXMsIDIwMCwgew=='),
  decode('ICAgICAgLy8gRW5naW5lIHByb2Nlc3MgY29udHJvbCBpcyBvd25lZCBieSBFbmdpbmVBZG1pbmlzdHJhdGlvbi4KICAgICAgY29uc3QgbW9kZSA9IHJ1bnRpbWVDb25maWcub3JjaGVzdHJhdGlvbk1vZGU7CiAgICAgIGxldCBlbmdpbmVTcGF3bmVkID0gZmFsc2U7CiAgICAgIGxldCBlbmdpbmVQaWQgPSBudWxsOwogICAgICBpZiAobW9kZSA9PT0gJ3YzJykgewogICAgICAgIHRyeSB7CiAgICAgICAgICBjb25zdCBzdGF0ZSA9IHNhZ2FBcHBsaWNhdGlvbi5zdGFydEVuZ2luZSh7IGVwaWNJZDogcmVzdWx0LmVwaWNJZCB9KTsKICAgICAgICAgIGVuZ2luZVNwYXduZWQgPSBzdGF0ZS5ydW5uaW5nOwogICAgICAgICAgZW5naW5lUGlkID0gc3RhdGUucGlkOwogICAgICAgIH0gY2F0Y2ggKGUpIHsKICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtjcmVhdGUtZnJvbS1pZGVhXSBlbmdpbmUgc3Bhd24gZmFpbGVkOiAke2UubWVzc2FnZX1gKTsKICAgICAgICB9CiAgICAgIH0='),
);
replaceBetween(
  'tracker-view/tracker-view.mjs',
  decode('Ly8gLS0tIEVuZ2luZSBjb250cm9sOiBzdGFydCAvIHN0b3AgLyBzdGF0dXMgLyByZXN0YXJ0IC0tLQ=='),
  decode('Ly8gLS0tIEtub3duIG1vZGVscyBjYXRhbG9nIHdpdGggY29uY3VycmVuY3kgbGltaXRzIC0tLQ=='),
  decode('Ly8gLS0tIEVuZ2luZSBjb250cm9sOiB0aGluIEhUVFAgYWRhcHRlciBvdmVyIEVuZ2luZUFkbWluaXN0cmF0aW9uIC0tLQoKZnVuY3Rpb24gcmVhZEpzb25SZXF1ZXN0KHJlcSwgY2FsbGJhY2spIHsKICBjb25zdCBjaHVua3MgPSBbXTsKICByZXEub24oJ2RhdGEnLCBjaHVuayA9PiBjaHVua3MucHVzaChjaHVuaykpOwogIHJlcS5vbignZW5kJywgKCkgPT4gewogICAgY29uc3QgcmF3ID0gQnVmZmVyLmNvbmNhdChjaHVua3MpLnRvU3RyaW5nKCd1dGY4Jyk7CiAgICBsZXQgZmllbGRzOwogICAgdHJ5IHsgZmllbGRzID0gSlNPTi5wYXJzZShyYXcpOyB9IGNhdGNoIHsgZmllbGRzID0ge307IH0KICAgIGNhbGxiYWNrKGZpZWxkcyk7CiAgfSk7Cn0KCmZ1bmN0aW9uIHJlc3BvbmRFbmdpbmVFcnJvcihyZXMsIGVycm9yKSB7CiAgY29uc3QgY29kZSA9IGVycm9yPy5jb2RlOwogIGNvbnN0IHN0YXR1cyA9IGNvZGUgPT09ICdlcGljX25vdF9mb3VuZCcgPyA0MDQKICAgIDogKGNvZGUgPT09ICdpbnZhbGlkX2VwaWMnIHx8IGNvZGUgPT09ICdpbnZhbGlkX2NvbmN1cnJlbmN5JykgPyA0MDAKICAgIDogNTAwOwogIHJlc3BvbmRKc29uKHJlcywgc3RhdHVzLCB7IG9rOiBmYWxzZSwgZXJyb3I6IGVycm9yPy5tZXNzYWdlIHx8IFN0cmluZyhlcnJvcikgfSk7Cn0KCmZ1bmN0aW9uIGhhbmRsZUVuZ2luZVN0YXJ0KHJlcSwgcmVzKSB7CiAgcmVhZEpzb25SZXF1ZXN0KHJlcSwgZmllbGRzID0+IHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IGVwaWNJZCA9IE51bWJlcihmaWVsZHMuZXBpY19pZCk7CiAgICAgIGNvbnN0IGNvbmN1cnJlbmN5ID0gZmllbGRzLmNvbmN1cnJlbmN5ID09PSB1bmRlZmluZWQKICAgICAgICA/IHVuZGVmaW5lZAogICAgICAgIDogTnVtYmVyKGZpZWxkcy5jb25jdXJyZW5jeSk7CiAgICAgIGNvbnN0IHN0YXRlID0gc2FnYUFwcGxpY2F0aW9uLnN0YXJ0RW5naW5lKHsgZXBpY0lkLCBjb25jdXJyZW5jeSB9KTsKICAgICAgcmVzcG9uZEpzb24ocmVzLCAyMDAsIHsKICAgICAgICBvazogdHJ1ZSwKICAgICAgICBwcm9qZWN0X2lkOiBzdGF0ZS5wcm9qZWN0SWQsCiAgICAgICAgZXBpY19pZDogc3RhdGUuZXBpY0lkLAogICAgICAgIGNvbmN1cnJlbmN5OiBzdGF0ZS5jb25jdXJyZW5jeSwKICAgICAgICBlbmdpbmVfcGlkOiBzdGF0ZS5waWQsCiAgICAgICAgcnVubmluZzogc3RhdGUucnVubmluZywKICAgICAgfSk7CiAgICB9IGNhdGNoIChlcnJvcikgewogICAgICByZXNwb25kRW5naW5lRXJyb3IocmVzLCBlcnJvcik7CiAgICB9CiAgfSk7Cn0KCmZ1bmN0aW9uIGhhbmRsZUVuZ2luZVN0b3AocmVxLCByZXMpIHsKICByZWFkSnNvblJlcXVlc3QocmVxLCBmaWVsZHMgPT4gewogICAgdHJ5IHsKICAgICAgY29uc3Qgc3RhdGUgPSBzYWdhQXBwbGljYXRpb24uc3RvcEVuZ2luZShOdW1iZXIoZmllbGRzLmVwaWNfaWQpKTsKICAgICAgcmVzcG9uZEpzb24ocmVzLCAyMDAsIHsKICAgICAgICBvazogdHJ1ZSwKICAgICAgICBwcm9qZWN0X2lkOiBzdGF0ZS5wcm9qZWN0SWQsCiAgICAgICAgZXBpY19pZDogc3RhdGUuZXBpY0lkLAogICAgICAgIHJ1bm5pbmc6IHN0YXRlLnJ1bm5pbmcsCiAgICAgIH0pOwogICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgcmVzcG9uZEVuZ2luZUVycm9yKHJlcywgZXJyb3IpOwogICAgfQogIH0pOwp9CgpmdW5jdGlvbiBoYW5kbGVFbmdpbmVDb25jdXJyZW5jeShyZXEsIHJlcykgewogIHJlYWRKc29uUmVxdWVzdChyZXEsIGZpZWxkcyA9PiB7CiAgICB0cnkgewogICAgICBjb25zdCBzdGF0ZSA9IHNhZ2FBcHBsaWNhdGlvbi5zZXRFbmdpbmVDb25jdXJyZW5jeSgKICAgICAgICBOdW1iZXIoZmllbGRzLmVwaWNfaWQpLAogICAgICAgIE51bWJlcihmaWVsZHMuY29uY3VycmVuY3kpLAogICAgICApOwogICAgICByZXNwb25kSnNvbihyZXMsIDIwMCwgewogICAgICAgIG9rOiB0cnVlLAogICAgICAgIGVwaWNfaWQ6IHN0YXRlLmVwaWNJZCwKICAgICAgICBjb25jdXJyZW5jeTogc3RhdGUuY29uY3VycmVuY3ksCiAgICAgIH0pOwogICAgfSBjYXRjaCAoZXJyb3IpIHsKICAgICAgcmVzcG9uZEVuZ2luZUVycm9yKHJlcywgZXJyb3IpOwogICAgfQogIH0pOwp9CgpmdW5jdGlvbiBoYW5kbGVFbmdpbmVTdGF0dXMocmVxLCByZXMsIHVybCkgewogIHRyeSB7CiAgICBjb25zdCBzdGF0ZSA9IHNhZ2FBcHBsaWNhdGlvbi5nZXRFbmdpbmVTdGF0dXMoCiAgICAgIE51bWJlcih1cmwuc2VhcmNoUGFyYW1zLmdldCgnZXBpY19pZCcpKSwKICAgICk7CiAgICByZXNwb25kSnNvbihyZXMsIDIwMCwgewogICAgICBvazogdHJ1ZSwKICAgICAgZXBpY19pZDogc3RhdGUuZXBpY0lkLAogICAgICBydW5uaW5nOiBzdGF0ZS5ydW5uaW5nLAogICAgICBwaWQ6IHN0YXRlLnBpZCwKICAgICAgY29uY3VycmVuY3k6IHN0YXRlLmNvbmN1cnJlbmN5LAogICAgICBzdGFydGVkX2F0OiBzdGF0ZS5zdGFydGVkQXQsCiAgICAgIGFsaXZlOiBzdGF0ZS5hbGl2ZSwKICAgIH0pOwogIH0gY2F0Y2ggKGVycm9yKSB7CiAgICByZXNwb25kRW5naW5lRXJyb3IocmVzLCBlcnJvcik7CiAgfQp9CgpmdW5jdGlvbiBoYW5kbGVFbmdpbmVSZXN0YXJ0KHJlcSwgcmVzKSB7CiAgcmVhZEpzb25SZXF1ZXN0KHJlcSwgZmllbGRzID0+IHsKICAgIHRyeSB7CiAgICAgIGNvbnN0IGVwaWNJZCA9IE51bWJlcihmaWVsZHMuZXBpY19pZCk7CiAgICAgIGNvbnN0IGNvbmN1cnJlbmN5ID0gZmllbGRzLmNvbmN1cnJlbmN5ID09PSB1bmRlZmluZWQKICAgICAgICA/IHVuZGVmaW5lZAogICAgICAgIDogTnVtYmVyKGZpZWxkcy5jb25jdXJyZW5jeSk7CiAgICAgIGNvbnN0IHN0YXRlID0gc2FnYUFwcGxpY2F0aW9uLnJlc3RhcnRFbmdpbmUoeyBlcGljSWQsIGNvbmN1cnJlbmN5IH0pOwogICAgICByZXNwb25kSnNvbihyZXMsIDIwMCwgewogICAgICAgIG9rOiB0cnVlLAogICAgICAgIHByb2plY3RfaWQ6IHN0YXRlLnByb2plY3RJZCwKICAgICAgICBlcGljX2lkOiBzdGF0ZS5lcGljSWQsCiAgICAgICAgY29uY3VycmVuY3k6IHN0YXRlLmNvbmN1cnJlbmN5LAogICAgICAgIGVuZ2luZV9waWQ6IHN0YXRlLnBpZCwKICAgICAgICBydW5uaW5nOiBzdGF0ZS5ydW5uaW5nLAogICAgICB9KTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7CiAgICAgIHJlc3BvbmRFbmdpbmVFcnJvcihyZXMsIGVycm9yKTsKICAgIH0KICB9KTsKfQoK'),
);
replaceOnce(
  'tracker-view/tracker-view.mjs',
  "const LMSTUDIO_URL = (process.env.SAGA_LMSTUDIO_URL || 'http://localhost:1234/v1').replace(/\\/+$/, '');",
  "const LMSTUDIO_URL = runtimeConfig.lmStudioUrl.replace(/\\/+$/, '');",
);
replaceOnce(
  'tracker-view/tracker-view.mjs',
  "const ZAI_DEFAULT_BASE_URL = process.env.SAGA_ZAI_BASE_URL || 'https://api.z.ai/api/anthropic';",
  "const ZAI_DEFAULT_BASE_URL = runtimeConfig.zaiBaseUrl;",
);
replaceOnce(
  'tracker-view/tracker-view.mjs',
  "const SPAWNED = process.env.TRACKER_SPAWNED === '1';",
  "const SPAWNED = runtimeConfig.trackerSpawned;",
);
replaceOnce(
  'tracker-view/tracker-view.mjs',
  "if (process.env.TRACKER_NO_BROWSER !== '1') {",
  "if (!runtimeConfig.trackerNoBrowser) {",
);
replaceOnce(
  'tracker-view/tracker-view.mjs',
  "process.on('exit',  () => { boardRunner.dispose(); try { unlinkSync(PID_FILE); } catch {} });\nprocess.on('SIGINT', () => { boardRunner.dispose(); try { unlinkSync(PID_FILE); } catch {} process.exit(0); });\nprocess.on('SIGTERM',() => { boardRunner.dispose(); try { unlinkSync(PID_FILE); } catch {} process.exit(0); });",
  "process.on('exit',  () => { boardRunner.dispose(); sagaApplication.close(); try { unlinkSync(PID_FILE); } catch {} });\nprocess.on('SIGINT', () => { boardRunner.dispose(); sagaApplication.close(); try { unlinkSync(PID_FILE); } catch {} process.exit(0); });\nprocess.on('SIGTERM',() => { boardRunner.dispose(); sagaApplication.close(); try { unlinkSync(PID_FILE); } catch {} process.exit(0); });",
);

// stable pump: receive WorkerExecutorFactory rather than constructing Claude.
replaceOnce('src/orchestrate.ts', decode('aW1wb3J0IHsgc3Bhd24gYXMgbm9kZVNwYXduIH0gZnJvbSAnbm9kZTpjaGlsZF9wcm9jZXNzJzsK'), '');
replaceOnce('src/orchestrate.ts', decode('aW1wb3J0IHsgY3JlYXRlQ2xhdWRlQm9hcmRSdW5uZXIgfSBmcm9tICcuLi90cmFja2VyLXZpZXcvY2xhdWRlLXJ1bm5lci5tanMnOwo='), '');
replaceOnce('src/orchestrate.ts', decode('aW1wb3J0IHsgaGFuZGxlcnMgYXMgZGlzcGF0Y2hlckhhbmRsZXJzIH0gZnJvbSAnLi90b29scy9kaXNwYXRjaGVyLmpzJzsK'), '');
replaceOnce('src/orchestrate.ts', decode('aW1wb3J0IHsgcmVsZWFzZUV4ZWN1dGlvbkF0b21pY2FsbHkgfSBmcm9tICcuL2xpZmVjeWNsZS9hdG9taWMtcmVsZWFzZS5qcyc7Cg=='), '');
replaceOnce('src/orchestrate.ts', decode('aW1wb3J0IHsgZ2V0RGIsIGNsb3NlRGIgfSBmcm9tICcuL2RiLmpzJzs='), decode('aW1wb3J0IHsgZ2V0RGIsIGNsb3NlRGIgfSBmcm9tICcuL2RiLmpzJzsKaW1wb3J0IHR5cGUgewogIFdvcmtlckV4ZWN1dG9yRmFjdG9yeSwKICBXb3JrZXJSdW5TbmFwc2hvdCwKfSBmcm9tICcuL2FwcGxpY2F0aW9uL3BvcnRzL3dvcmtlci1leGVjdXRvci5qcyc7'));
replaceBetween(
  'src/orchestrate.ts',
  decode('ZXhwb3J0IGludGVyZmFjZSBPcmNoZXN0cmF0ZU9wdGlvbnMgew=='),
  decode('Cn0KCmV4cG9ydCBpbnRlcmZhY2UgT3JjaGVzdHJhdGVSZXN1bHQ='),
  decode('ZXhwb3J0IGludGVyZmFjZSBPcmNoZXN0cmF0ZU9wdGlvbnMgewogIHByb2plY3RJZDogbnVtYmVyOwogIGVwaWNJZDogbnVtYmVyOwogIGNvbmN1cnJlbmN5PzogbnVtYmVyOwogIGNsYXVkZVBhdGg/OiBzdHJpbmc7CiAgZGJQYXRoOiBzdHJpbmc7CiAgbG1TdHVkaW9Vcmw6IHN0cmluZzsKICB3b3JrZXJFeGVjdXRvckZhY3Rvcnk6IFdvcmtlckV4ZWN1dG9yRmFjdG9yeTsKICBzYWdhRW50cnk/OiBzdHJpbmc7CiAgc2FnYVNraWxsUm9vdD86IHN0cmluZzsKICBsb2dSb290Pzogc3RyaW5nOwogIGhlYXJ0YmVhdExvZz86IHN0cmluZzsKICAvKiogSW5qZWN0YWJsZSBjbG9jayAobXMpIGZvciB0ZXN0cy4gKi8KICBub3c/OiAoKSA9PiBudW1iZXI7CiAgLyoqIEluamVjdGFibGUgc2xlZXAgZm9yIHRlc3RzLiAqLwogIHNsZWVwPzogKG1zOiBudW1iZXIpID0+IFByb21pc2U8dm9pZD47Cn0='),
);
replaceBetween(
  'src/orchestrate.ts',
  decode('ICBjb25zdCBydW5uZXIgPSBjcmVhdGVDbGF1ZGVCb2FyZFJ1bm5lcih7'),
  decode('CgogIGVuZ2luZUhlYXJ0YmVhdChvcHRzLCAnRU5HSU5FX1NUQVJUJyw='),
  decode('ICBjb25zdCBydW5uZXIgPSBvcHRzLndvcmtlckV4ZWN1dG9yRmFjdG9yeSh7CiAgICBwcm9qZWN0SWQsCiAgICBlcGljSWQsCiAgICB3b3Jrc3BhY2VSb290LAogICAgZGJQYXRoOiBvcHRzLmRiUGF0aCwKICAgIHNhZ2FFbnRyeTogb3B0cy5zYWdhRW50cnkgPz8gcGF0aC5qb2luKF9fZGlybmFtZSwgJy4uJywgJ2Rpc3QnLCAnaW5kZXguanMnKSwKICAgIHNhZ2FTa2lsbFJvb3Q6IG9wdHMuc2FnYVNraWxsUm9vdCA/PyBwYXRoLmpvaW4oX19kaXJuYW1lLCAnLi4nLCAnc2tpbGxzJyksCiAgICBjbGF1ZGVQYXRoOiBvcHRzLmNsYXVkZVBhdGgsCiAgICBsb2dSb290OiBvcHRzLmxvZ1Jvb3QsCiAgICBoZWFydGJlYXRMb2c6IG9wdHMuaGVhcnRiZWF0TG9nLAogICAgbG1TdHVkaW9Vcmw6IG9wdHMubG1TdHVkaW9VcmwsCiAgfSk7'),
);
replaceOnce(
  'src/orchestrate.ts',
  '      let run: ReturnType<typeof runner.status>;',
  '      let run: WorkerRunSnapshot | null;',
);

// Guard the user-supplied model-selector fix. Fail rather than silently remove it.
const tracker = readFileSync(abs('tracker-view/tracker-view.mjs'), 'utf8');
for (const slot of [
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
]) {
  if (!tracker.includes(`payload.env.${slot} = modelId`)) {
    throw new Error(`LM Studio hard rule lost: ${slot}`);
  }
}
if (!tracker.includes('CLAUDE_SETTINGS_LMSTUDIO_TPL')) {
  throw new Error('LM Studio persistent template fix lost');
}

console.log('Phase B block 1-4 applied successfully.');
