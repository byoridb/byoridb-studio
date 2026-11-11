/**
 * Service and OS errors as Korean sentences. `message` is what the panel shows;
 * `detail` keeps the original text for a tooltip when it was rewritten.
 */
export interface ErrorText {
  message: string;
  detail?: string;
}

type Particle = "object" | "subject" | "topic";

/** Each sentence names the particle its subject takes: 을/를, 이/가 or 은/는. */
const osErrors: Record<string, [Particle, string]> = {
  "2": ["object", "찾을 수 없습니다. 파일이 옮겨졌거나 삭제되었는지 확인하고 다시 선택하세요."],
  "13": ["object", "열 권한이 없습니다. 파일 권한을 확인하거나 다른 위치의 파일을 선택하세요."],
  "17": ["subject", "이미 있습니다. 다른 이름을 사용하세요."],
  "21": ["topic", "폴더입니다. 파일을 선택하세요."],
  "28": ["object", "저장할 공간이 부족합니다. 디스크 공간을 확보한 뒤 다시 시도하세요."],
};

/** "자막 파일 읽기 실패" → "자막 파일": the thing the OS error is about. */
const subjectOf = (prefix: string) =>
  prefix
    .replace(/^Error:\s*/, "")
    .replace(/\s*(읽기|쓰기|열기|저장|가져오기|복사|확인)?\s*(실패|오류)\s*$/, "")
    .trim();

const particles: Record<Particle, [string, string]> = {
  object: ["을", "를"],
  subject: ["이", "가"],
  topic: ["은", "는"],
};

/** Attaches a particle by the final consonant of a Hangul word. */
const withParticle = (word: string, kind: Particle) => {
  const [closed, open] = particles[kind];
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return `${word}${closed}(${open})`;
  return `${word}${code % 28 ? closed : open}`;
};

export function errorText(error: unknown, subject?: string): ErrorText {
  const raw = (error instanceof Error ? error.message : String(error ?? ""))
    .replace(/^Error:\s*/, "")
    .trim();
  if (!raw) return { message: "작업을 완료하지 못했습니다. 다시 시도해 주세요." };
  if (
    error instanceof TypeError ||
    /^(Failed to fetch|Load failed|NetworkError)/i.test(raw)
  )
    return {
      message: "편집 서비스에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요.",
      detail: raw,
    };
  const os = raw.match(/^(.*?)[:：]?\s*[^:：]*\(os error (\d+)\)\s*$/);
  if (os) {
    const what = subject || subjectOf(os[1]) || "파일";
    const known = osErrors[os[2]];
    return {
      message: known
        ? `${withParticle(what, known[0])} ${known[1]}`
        : `${withParticle(what, "object")} 처리하지 못했습니다. 다시 시도해 주세요.`,
      detail: raw,
    };
  }
  // A trailing service code such as "(REVISION_CONFLICT)" is for logs, not for reading.
  const coded = raw.match(/^(.*\S)\s*\(([A-Z][A-Z_]{3,})\)\s*$/);
  if (coded) return { message: coded[1], detail: raw };
  return { message: raw };
}
