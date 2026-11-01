import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 프로젝트 루트의 .env 자동 로드 (Node 20.12+/21.7+ 내장 기능)
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath) && typeof process.loadEnvFile === 'function' && process.env.NODE_ENV !== 'test') {
  process.loadEnvFile(envPath);
}

const env = process.env;

/**
 * 지도 설정.
 *  MAP_PROVIDER=kakao|naver|leaflet (생략 시 키가 있는 쪽 자동 선택, 둘 다 없으면 leaflet)
 *  KAKAO_MAP_KEY      카카오 디벨로퍼스 > 앱 > JavaScript 키
 *  NAVER_MAP_KEY_ID   네이버 클라우드 플랫폼 > Maps > Application 의 Client ID
 *
 * 이 키들은 브라우저에 노출되는 "공개용" 키이며, 각 콘솔에서 허용 도메인(웹 서비스 URL)을 등록해야 동작한다.
 */
export function mapConfig() {
  const kakao = env.KAKAO_MAP_KEY?.trim();
  const naver = env.NAVER_MAP_KEY_ID?.trim();
  let provider = env.MAP_PROVIDER?.trim().toLowerCase();
  if (!provider) provider = kakao ? 'kakao' : naver ? 'naver' : 'leaflet';
  const key = provider === 'kakao' ? kakao : provider === 'naver' ? naver : undefined;
  if (provider !== 'leaflet' && !key) {
    console.warn(`[config] MAP_PROVIDER=${provider} 이지만 API 키가 없어 leaflet 으로 대체합니다.`);
    return { provider: 'leaflet' };
  }
  return { provider, key };
}
