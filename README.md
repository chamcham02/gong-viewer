# 병렬노트 뷰어

이 저장소에는 **화면 코드만** 들어 있습니다. 학습 내용, 하이라이트, 메모, 토큰은 들어 있지 않습니다.

- 내용과 하이라이트·메모는 비공개 저장소에 있고, 뷰어를 열 때 사용자가 입력한 GitHub 토큰으로 불러옵니다.
- 토큰은 그 기기 브라우저(localStorage)에만 저장되고 `api.github.com` 말고는 어디에도 보내지 않습니다 (페이지의 CSP가 다른 곳으로의 연결을 막습니다).
- 이 파일들은 비공개 저장소의 `tools/build.mjs`가 만듭니다. 여기서 직접 고치지 마세요.

## 쓰는 법

1. Settings → Pages → Branch: `main` / `(root)` → Save
2. GitHub에서 fine-grained 토큰 만들기: 비공개 저장소 하나만 선택, Permissions → Contents: Read and write
3. 이 페이지 주소를 열고 토큰을 붙여넣기 (기기마다 한 번)

## 주의

`<계정>.github.io` 아래의 Pages 사이트들은 같은 출처를 공유합니다. 이 계정의 다른 Pages 저장소에 남이 만든 코드를 올리면 저장된 토큰이 노출될 수 있습니다.
