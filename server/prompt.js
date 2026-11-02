import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { REGIONS, SOURCE_KEYS, describe, sanitize } from './conditions.js';
import { DEAL_TYPES, ROOM_TYPES } from './model.js';

const SOURCE_NAMES = { zigbang: '직방', dabang: '다방', naver: '네이버부동산', peterpan: '피터팬' };
const B = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;

/** "1,3" / "1 3" / "1-3" → [1,2,3] */
export function parseNumbers(input, max) {
  const out = new Set();
  for (const part of String(input).split(/[,\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) if (i >= 1 && i <= max) out.add(i);
    } else if (/^\d+$/.test(part) && Number(part) >= 1 && Number(part) <= max) out.add(Number(part));
  }
  return [...out];
}

function columns(items, cols = 3, width = 22) {
  const lines = [];
  for (let i = 0; i < items.length; i += cols) {
    lines.push(
      items
        .slice(i, i + cols)
        .map((s) => {
          // 한글은 화면에서 2칸을 차지하므로 패딩 보정
          const visual = [...s].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
          return s + ' '.repeat(Math.max(1, width - visual));
        })
        .join(''),
    );
  }
  return lines.join('\n');
}

async function chooseMany(rl, title, options, current, { cols = 4, width = 16 } = {}) {
  const labels = options.map((o, i) => `${String(i + 1).padStart(2)}) ${o.label}`);
  console.log(`\n${B(title)}`);
  console.log(columns(labels, cols, width));
  const cur = options.filter((o) => current.includes(o.value)).map((o) => o.label).join(', ');
  for (;;) {
    const ans = (await rl.question(`번호 선택 (여러 개는 쉼표, Enter = ${cur || '전체'}): `)).trim();
    if (!ans) return current;
    const nums = parseNumbers(ans, options.length);
    if (nums.length) return nums.map((n) => options[n - 1].value);
    console.log('  번호를 다시 입력해 주세요.');
  }
}

async function askNumber(rl, label, current) {
  for (;;) {
    const ans = (await rl.question(`${label} (Enter = ${current ? current.toLocaleString() : '제한 없음'}, 0 = 제한 없음): `)).trim().replace(/,/g, '');
    if (!ans) return current;
    if (/^\d+$/.test(ans)) return Number(ans) || null;
    console.log('  숫자만 입력해 주세요 (만원 단위).');
  }
}

/**
 * 터미널에서 수집 조건을 묻는다.
 * @param {import('./conditions.js').Conditions} current 이전(또는 기본) 조건
 * @param {{saved:boolean}} opts
 */
export async function askConditions(current, { saved }) {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`\n${B('🏠 RoomFinder — 어떤 매물을 찾으세요?')}`);
    if (saved) {
      console.log(`${DIM('지난 조건:')} ${describe(current)}`);
      const again = (await rl.question('지난 조건 그대로 시작할까요? (Enter = 예 / n = 다시 설정): ')).trim().toLowerCase();
      if (again !== 'n' && again !== 'no' && again !== '아니오' && again !== 'ㅜ') return current;
    } else {
      console.log(DIM('각 질문에서 Enter 만 누르면 괄호 안의 기본값을 사용합니다. 나중에 웹 화면의 "수집 조건"에서도 바꿀 수 있어요.'));
    }

    const regions = await chooseMany(
      rl,
      '① 지역 (역 주변 반경 약 1km, 최대 6곳)',
      REGIONS.map((r) => ({ value: r.id, label: r.name })),
      current.regions,
      { cols: 3, width: 24 },
    );
    const dealTypes = await chooseMany(rl, '② 거래 유형', DEAL_TYPES.map((d) => ({ value: d, label: d })), current.dealTypes);
    const roomTypes = await chooseMany(rl, '③ 방 종류', ROOM_TYPES.map((r) => ({ value: r, label: r })), current.roomTypes, { cols: 3 });

    console.log(`\n${B('④ 가격 상한 (만원)')}`);
    const depositMax = dealTypes.some((d) => d !== '매매') ? await askNumber(rl, '보증금·전세금 최대', current.depositMax) : null;
    const rentMax = dealTypes.includes('월세') ? await askNumber(rl, '월세 최대', current.rentMax) : null;

    const sources = await chooseMany(
      rl,
      '⑤ 플랫폼',
      SOURCE_KEYS.map((k) => ({ value: k, label: SOURCE_NAMES[k] })),
      current.sources,
      { cols: 4, width: 18 },
    );

    const next = sanitize({ ...current, regions, dealTypes, roomTypes, depositMax, rentMax, sources });
    if (regions.length > next.regions.length) console.log(DIM(`지역은 최대 6곳까지만 수집해요: ${next.regions.length}곳만 사용합니다.`));
    console.log(`\n${B('✔ 설정 완료:')} ${describe(next)}`);
    return next;
  } finally {
    rl.close();
  }
}
