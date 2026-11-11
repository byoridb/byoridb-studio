import { describe, expect, it } from "vitest";
import { errorText } from "./errorText";

describe("errorText", () => {
  it("turns an OS error into a Korean sentence about the file and keeps the original as a detail", () => {
    const raw = "자막 파일 읽기 실패: No such file or directory (os error 2)";
    expect(errorText(new Error(raw))).toEqual({
      message: "자막 파일을 찾을 수 없습니다. 파일이 옮겨졌거나 삭제되었는지 확인하고 다시 선택하세요.",
      detail: raw,
    });
    expect(errorText("Error: 글꼴 복사 실패: Permission denied (os error 13)").message).toMatch(
      /^글꼴을 열 권한이 없습니다/,
    );
    // The caller can name the subject; an unknown code still hides the OS text.
    const unknown = errorText(new Error("failed: Device busy (os error 16)"), "LUT 파일");
    expect(unknown.message).toBe("LUT 파일을 처리하지 못했습니다. 다시 시도해 주세요.");
    expect(unknown.detail).toContain("os error 16");
  });

  it("uses the particle each OS sentence needs, not always 을/를", () => {
    expect(errorText("쓰기 실패: File exists (os error 17)", "내보내기 파일").message).toBe(
      "내보내기 파일이 이미 있습니다. 다른 이름을 사용하세요.",
    );
    expect(errorText("LUT 읽기 실패: Is a directory (os error 21)", "LUT 파일").message).toBe(
      "LUT 파일은 폴더입니다. 파일을 선택하세요.",
    );
    // A final consonant picks the other form; a non-Hangul ending shows both.
    expect(errorText("글꼴 복사 실패: File exists (os error 17)").message).toMatch(
      /^글꼴이 이미 있습니다/,
    );
    expect(errorText("자막 읽기 실패: Is a directory (os error 21)", "자막").message).toMatch(
      /^자막은 폴더입니다/,
    );
    expect(errorText("failed: Is a directory (os error 21)", "LUT").message).toMatch(
      /^LUT은\(는\) 폴더입니다/,
    );
    expect(errorText("failed: No space left on device (os error 28)", "프로젝트").message).toMatch(
      /^프로젝트를 저장할 공간이 부족합니다/,
    );
  });

  it("drops a trailing service code and leaves Korean service messages alone", () => {
    expect(
      errorText(new Error("프로젝트가 다른 작업에 의해 변경되었습니다. (REVISION_CONFLICT)")),
    ).toEqual({
      message: "프로젝트가 다른 작업에 의해 변경되었습니다.",
      detail: "프로젝트가 다른 작업에 의해 변경되었습니다. (REVISION_CONFLICT)",
    });
    expect(errorText(new Error("잠긴 트랙입니다."))).toEqual({ message: "잠긴 트랙입니다." });
  });

  it("explains an unreachable service and an empty error", () => {
    expect(errorText(new TypeError("Failed to fetch")).message).toBe(
      "편집 서비스에 연결할 수 없습니다. 잠시 뒤 다시 시도해 주세요.",
    );
    expect(errorText("").message).toBe("작업을 완료하지 못했습니다. 다시 시도해 주세요.");
  });
});
