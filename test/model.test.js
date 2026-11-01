import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressKey, parseAddress, parseFloor, parseKoreanMoney } from '../server/model.js';

test('플랫폼별로 다른 주소 표기를 같은 키로 정규화한다', () => {
  const keys = [
    '서울특별시 마포구 서교동 123-4번지',
    '서울시 마포구 서교동 123-4',
    '마포구 서교동 123-4',
    '서울  마포구   서교동 123-4',
  ].map((a) => addressKey(parseAddress(a)));
  assert.equal(new Set(keys).size, 1);
  assert.equal(keys[0], '마포구|서교동|123-4');
});

test('"123-0" 과 "123" 은 같은 지번', () => {
  assert.equal(parseAddress('마포구 망원동 123-0').jibun, '123');
});

test('주소에 동/지번이 없으면 키를 만들지 않는다', () => {
  assert.equal(addressKey(parseAddress('서울 마포구')), '');
});

test('층 표기 파싱', () => {
  assert.deepEqual(parseFloor('3층'), { floor: 3, totalFloors: null });
  assert.deepEqual(parseFloor('3/15'), { floor: 3, totalFloors: 15 });
  assert.deepEqual(parseFloor('B1/6'), { floor: -1, totalFloors: 6 });
  assert.deepEqual(parseFloor('지하2층'), { floor: -2, totalFloors: null });
  assert.deepEqual(parseFloor('반지하/4'), { floor: -0.5, totalFloors: 4 });
  assert.deepEqual(parseFloor('고/25'), { floor: null, totalFloors: 25 });
  assert.deepEqual(parseFloor('옥탑/5'), { floor: 5.5, totalFloors: 5 });
});

test('한국식 금액 표기 → 만원', () => {
  assert.equal(parseKoreanMoney('2억 1,000'), 21000);
  assert.equal(parseKoreanMoney('1억5000'), 15000);
  assert.equal(parseKoreanMoney('3억'), 30000);
  assert.equal(parseKoreanMoney('5,000'), 5000);
  assert.ok(Number.isNaN(parseKoreanMoney('')));
  assert.ok(Number.isNaN(parseKoreanMoney('협의')));
});
