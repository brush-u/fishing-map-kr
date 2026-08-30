# 대한민국 낚시지도 (fishing-map-kr)

바다낚시 + 민물낚시 포인트를 지도에 표시하고, 포인트별로 날씨·물때·주변 편의점/상점 정보를 보여주는 웹앱입니다.
지도 엔진은 **Leaflet + OpenStreetMap** (키 불필요, 완전 무료)을 사용합니다. Leaflet 자체도 CDN 대신
`public/vendor/leaflet/`에 파일로 내장해뒀습니다 (CDN 장애/차단에 영향받지 않도록).

> 현재 상태: **동작하는 프로토타입**입니다. 낚시포인트는 전국 단위를 보여주기 위한 **샘플(시연용) 데이터 38곳**이 들어있고,
> 날씨는 기상청 API 연동 코드가 완성되어 있습니다(키만 넣으면 실제 값 표시). 물때(KHOA)는 구조만 잡아두고
> 실제 연동은 아래 "해야 할 일"의 4번을 따라 완성해야 합니다.

**권역별 그룹핑**: 처음 지도를 열면 개별 포인트 대신 전국 17개 시/도 경계선(폴리곤)이 표시되고, 각 권역에
속한 낚시포인트 수가 진하기와 툴팁으로 나타납니다. 폴리곤을 클릭하면 해당 권역의 낚시포인트가 모두 표시되고,
화면 상단의 "← 전체 권역 보기"로 다시 돌아갈 수 있습니다.

경계 데이터는 통계청(KOSTAT) 2013년 행정구역 경계를 [southkorea/southkorea-maps](https://github.com/southkorea/southkorea-maps)
저장소에서 받아(`free to share or remix` 라이선스), `mapshaper`로 3%까지 단순화해 `data/boundaries/skorea-provinces.geo.json`
(약 470KB)으로 만들어 넣었습니다. 각 낚시포인트가 어느 시/도에 속하는지는 좌표를 폴리곤에 대해 point-in-polygon
판정(`public/app.js`의 `pointInGeometry`)으로 직접 계산합니다 — 해안 지점이 단순화된 경계선 밖으로 살짝 벗어나면
가장 가까운 시/도로 자동 보정합니다. 2013년 자료라 강원도/전라북도는 현재의 강원특별자치도/전북특별자치도와
이름이 다른데, 표시용 이름만 다른 거라 그룹핑 자체에는 영향이 없습니다.

**권역 선택 후 낚시터 목록/상세정보**: 권역(시/도)을 클릭하면 지도 좌측에 그 권역의 낚시터 목록(이름·바다/민물
구분·주요어종)이 패널로 뜹니다. 목록에서 하나를 클릭하면 지도가 그 지점으로 이동하면서, 우측 패널에 날씨·물때·
주변 편의점/상점까지 포함한 상세 정보가 표시됩니다 — 지도에서 마커를 직접 클릭해도 동일한 상세 정보가 열립니다.
필터(바다/민물) 체크박스를 바꾸면 좌측 목록과 지도 마커가 함께 갱신됩니다.

**전체 권역 보기로 돌아가는 방법**: ① 상단 "← 전체 권역 보기" 버튼, ② 상세정보 패널 안의 "🗺 전체 권역 보기" 버튼,
③ 지도를 마우스 휠/핀치로 줌아웃하면 **자동으로** 전체 권역(시/도 경계) 뷰로 돌아갑니다 — 세 가지 방법 모두 동일하게 동작합니다.
(자동 전환 기준: 전국 17개 시/도 드릴다운 시 도달하는 최소 줌 레벨이 8이라, 줌 7 이하로 내려가면 전환되도록 해뒀습니다.)

**모바일 대응**: 휴대폰 폭(680px 이하)에서는 좌/우로 나란히 뜨던 낚시터 목록·상세정보 패널이 화면 하단에서
올라오는 바텀시트 형태로 바뀌고, 상세정보가 목록 위에 겹쳐 뜹니다. 지도 줌 컨트롤도 좌측 상단(목록 패널과 겹치던 자리)에서
좌측 하단으로 옮겨뒀습니다.

---

## 1. 로컬에서 실행해보기

```bash
npm install
cp .env.example .env     # 키는 비워둬도 일단 실행은 됩니다 (예시 값으로 표시됨)
npm start
# http://localhost:8080 접속
```

키 없이 실행하면:
- 낚시포인트 지도 ✅ 정상 동작 (샘플 데이터)
- 주변 편의점/상점 ✅ 정상 동작 (OSM Overpass, 키 불필요)
- 날씨 ⚠️ "예시 데이터"로 표시 (KMA_FORECAST_KEY 넣으면 실제 값)
- 물때 ⚠️ "예시 데이터"로 표시 (4번 TODO 완료 후 실제 값)

---

## 2. 전국 공식 데이터로 교체하기

지금 들어있는 `data/spots.sample.geojson`은 시연용 샘플(37곳, 좌표 근사치)입니다.
전국 단위 실제 데이터로 바꾸려면:

1. 아래 두 파일을 직접 다운로드합니다 (공공데이터포털은 이 환경에서 직접 접근이 막혀 있어 제가 대신 받아둘 수 없습니다 — **이 부분은 사용자가 직접 해야 합니다**):
   - [전국낚시터정보표준데이터](https://www.data.go.kr/data/15021144/standard.do) (바다+민물 포함, CSV, 로그인 없이 다운로드 가능)
   - [갯바위낚시포인트](https://www.data.go.kr/data/15148580/fileData.do) (바다 갯바위 특화, CSV)
2. 두 파일을 `data/raw/` 폴더에 원래 파일명 그대로 넣습니다.
3. 변환 스크립트 실행:
   ```bash
   npm run import:spots
   ```
4. `data/spots.geojson`이 생성되면 서버가 자동으로 샘플 대신 이 파일을 사용합니다.

> CSV 헤더(컬럼명)가 스크립트의 기대값과 다르면 `data/scripts/import_standard_csv.js`의
> `COLUMN_ALIASES`에 실제 헤더명을 추가해주세요. (공공데이터는 가끔 컬럼명이 버전마다 조금 다릅니다.)

추가로 민물 데이터를 더 보강하려면 한국농어촌공사의 저수지 관련 공공데이터([data.go.kr 검색: "저수지 현황"](https://www.data.go.kr))도 같은 방식으로 합칠 수 있습니다.

---

## 3. 당신이 해야 할 일 (체크리스트)

### ① 공공데이터포털 API 키 발급 — 무료, 본인 계정 필요
아래는 모두 [data.go.kr](https://www.data.go.kr) 회원가입 → 로그인 → 각 페이지에서 **"활용신청"** 클릭 → 보통 수 분~1일 내 자동/수동 승인 → "마이페이지 > 개발계정"에서 **일반 인증키(Encoding)** 복사.

- [ ] [기상청_단기예보 조회서비스](https://www.data.go.kr/data/15084084/openapi.do) → `.env`의 `KMA_FORECAST_KEY` — **이 키는 넣는 순간 바로 실제 날씨로 전환됩니다.**
- [ ] [국립해양조사원_조석예보](https://www.data.go.kr/data/15038991/openapi.do) → `.env`의 `KHOA_TIDE_KEY` — 키만으론 부족하고, 관측소 코드도 같이 필요합니다 (아래 ⑤ 참고).
- [ ] (선택) [국립해양조사원_바다낚시지수 조회](https://www.data.go.kr/data/15142486/openapi.do) → `.env`의 `KHOA_FISHING_INDEX_KEY` — 포인트별 물때+파고+수온+어종별 지수를 한 번에 주는 API라, 나중에 물때 패널을 더 풍부하게 바꾸고 싶을 때 쓸 수 있습니다. (지금 코드는 아직 이 키를 사용하지 않습니다.)
- [ ] (선택, 추천) [카카오 개발자센터](https://developers.kakao.com) → 카카오계정 로그인(카드 불필요) → 앱 생성 → "REST API 키" → `.env`의 `KAKAO_REST_API_KEY` — 주변 편의점/상점 조회를 OpenStreetMap 대신 카카오 로컬 API로 전환합니다. 국내 커버리지가 훨씬 좋고 빠릅니다 (일 10만 건 무료).

> 📌 **[갯바위낚시포인트](https://www.data.go.kr/data/15148580/fileData.do)는 오픈API가 없고 "파일데이터"만 제공됩니다.**
> 키 발급이 필요 없고, 로그인 없이 CSV를 바로 다운로드할 수 있습니다 — 위 2번 순서대로 `data/raw/`에 넣고
> `npm run import:spots`만 실행하면 됩니다.

> ⚠️ **`.env`는 로컬 실행(`npm start`)에서만 읽힙니다.** Cloud Run에 배포한 뒤에는 `.env` 파일이 컨테이너에 없으므로
> (`.gitignore`/`.dockerignore`에서 제외됨), 키는 반드시 ③의 `--set-env-vars` 또는 Secret Manager로 다시 넣어줘야 합니다.
> 로컬에서 키를 넣고 잘 되는 걸 확인한 다음, 같은 값을 Cloud Run에도 넣어주는 2단계라고 생각하시면 됩니다.

### ② GitHub
> ⚠️ **GitHub는 코드를 저장만 할 뿐, 그 자체로는 아무것도 "실행"해주지 않습니다.** 여기 push하는 것만으로는
> 휴대폰에서 접속할 수 있는 URL이 생기지 않습니다 — 이 앱은 Express 백엔드가 API를 처리해야 동작하는
> 서버 앱이라 GitHub Pages 같은 정적 호스팅도 안 됩니다. 실제로 폰에서 열어보려면 아래 ③(Cloud Run)처럼
> 어딘가에서 서버를 "실행"까지 시켜야 합니다. GitHub는 그 배포 과정의 소스 저장소 역할입니다.

- [ ] 새 저장소 생성 (예: `fishing-map-kr`), **Private/Public 원하는 대로** (github.com → New repository. "Add a README" 등 초기 파일 옵션은 전부 체크 해제하고 빈 저장소로 만드세요)
- [ ] 코드 push — `scripts/push-to-github.sh` 자동 스크립트를 넣어뒀습니다 (매번 `git add/commit/push`를 손으로 안 쳐도 됨):
  ```bash
  # 최초 1회는 방금 만든 저장소 URL과 함께 실행 (원격 연결 + 커밋 + push까지 한 번에)
  npm run push -- https://github.com/<내계정>/fishing-map-kr.git "Initial commit"

  # 이후로는 코드가 바뀔 때마다 그냥
  npm run push
  # 또는 커밋 메시지를 직접 쓰고 싶으면
  npm run push -- "낚시터 검색 기능 추가"
  ```
  Windows는 **Git Bash** 터미널에서 실행하세요 (cmd/PowerShell엔 기본 `bash`가 없습니다). 최초 1회 `chmod +x scripts/push-to-github.sh`가 필요할 수 있습니다.
  스크립트가 `.env`처럼 올라가면 안 되는 파일이 실수로 포함되진 않았는지 자동으로 확인한 뒤 push합니다.
  (직접 명령을 치고 싶다면 물론 평소처럼 `git add . && git commit -m "..." && git push`도 그대로 됩니다.)
  (이 환경에는 GitHub 로그인이 연결되어 있지 않아 제가 직접 푸시할 수 없습니다. 위 명령을 직접 실행해주세요.)

> ⚡ **당장 폰으로 빨리 테스트만 해보고 싶다면**, 아래 ③ Cloud Run 배포 없이도 가능합니다: 컴퓨터에서
> `npm start`로 서버를 켠 다음, 폰이 **같은 Wi-Fi**에 붙어있는 상태에서 컴퓨터의 로컬 IP로 접속하면 됩니다
> (`http://<컴퓨터의 사설IP>:8080`, 예: `http://192.168.0.5:8080`). Mac은 `ipconfig getifaddr en0`,
> Windows는 `ipconfig`로 로컬 IP를 확인할 수 있습니다. 단, Wi-Fi가 같은 동안만, 그리고 방화벽이
> 8080 포트를 막아두지 않았을 때만 됩니다 — 외부(LTE 등)에서는 접속이 안 되고, 그럴 땐 아래 ③이 필요합니다.

### ③ Google Cloud — Cloud Run 배포 (무료 티어로 충분, 어디서나/LTE로도 접속 가능)
GitHub에 push하는 것과는 **별개의 단계**입니다 — Cloud Run이 실제로 서버를 띄워서 공개 URL을 만들어주는
쪽이고, GitHub는 그 소스를 가져오는 곳일 뿐입니다. 아래 단계가 "구글 클라우드 설정"에 해당합니다.

- [ ] GCP 프로젝트 생성, **빌링 계정 연결** (Cloud Run은 카드 등록은 필요하지만, 이 정도 트래픽이면 무료 한도 내에서 과금 없이 운영됩니다)
- [ ] `gcloud` CLI 설치 후 로그인: `gcloud auth login && gcloud config set project <PROJECT_ID>`
- [ ] 배포 (GitHub push 여부와 무관하게, 로컬 코드 폴더에서 바로 실행 가능합니다 — `--source .`가 지금 폴더를 그대로 업로드해서 빌드합니다):
  ```bash
  gcloud run deploy fishing-map-kr \
    --source . \
    --region asia-northeast3 \
    --allow-unauthenticated \
    --set-env-vars KMA_FORECAST_KEY=xxxx,KHOA_TIDE_KEY=xxxx,KAKAO_REST_API_KEY=xxxx
  ```
  (키는 커밋하지 말고 위처럼 `--set-env-vars` 또는 **Secret Manager**로 주입하세요. 아직 안 받은 키가 있다면
  해당 부분은 빼고 배포해도 되고, 나중에 키를 받으면 `gcloud run services update fishing-map-kr
  --update-env-vars KAKAO_REST_API_KEY=xxxx`처럼 키 하나만 추가/갱신할 수 있습니다.)
  - 명령이 끝나면 `https://fishing-map-kr-xxxxx-an.a.run.app` 같은 URL이 출력됩니다 — 이 URL을 폰 브라우저에 입력하면 Wi-Fi든 LTE든 어디서나 접속됩니다.

### ④ GitHub 자동배포 (CI/CD) — main에 push하면 자동으로 Cloud Run에 배포

위 ③번을 매번 손으로 치는 대신, `main` 브랜치에 push할 때마다 GitHub Actions가 자동으로 Cloud Run에
배포해주는 스크립트를 `.github/workflows/deploy.yml`에 넣어뒀습니다. 아래 준비물만 한 번 세팅하면 됩니다.

**1) 배포용 서비스 계정 생성 + 권한 부여** (터미널에서, `gcloud auth login` 되어있는 상태에서 한 번만)
```bash
PROJECT_ID=$(gcloud config get-value project)

gcloud iam service-accounts create github-deployer --display-name "GitHub Actions Deployer"

SA_EMAIL="github-deployer@${PROJECT_ID}.iam.gserviceaccount.com"

for ROLE in roles/run.admin roles/iam.serviceAccountUser roles/cloudbuild.builds.editor roles/artifactregistry.writer roles/storage.admin; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA_EMAIL}" --role="$ROLE"
done

# 필요한 API 활성화 (한 번만)
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

# 이 서비스 계정의 키 파일 생성 (GitHub Secret에 넣을 값)
gcloud iam service-accounts keys create github-deployer-key.json --iam-account="$SA_EMAIL"
```

**2) GitHub 저장소에 Secrets 등록** — 저장소 페이지 → Settings → Secrets and variables → Actions →
"New repository secret"에서 아래 항목들을 하나씩 등록:

| Secret 이름 | 값 |
|---|---|
| `GCP_PROJECT_ID` | `echo $PROJECT_ID`로 확인한 프로젝트 ID |
| `GCP_SA_KEY` | 방금 만든 `github-deployer-key.json` 파일을 **텍스트 에디터로 열어 전체 내용**을 그대로 붙여넣기 |
| `KMA_FORECAST_KEY` | 기상청 키 |
| `KHOA_TIDE_KEY` | KHOA 물때 키 (아직 없으면 비워둬도 됨) |
| `KHOA_FISHING_INDEX_KEY` | (선택) |
| `KAKAO_REST_API_KEY` | (선택) |

> ⚠️ `github-deployer-key.json`은 클라우드 계정에 배포 권한이 있는 민감한 파일입니다. GitHub Secret에
> 등록한 뒤에는 **절대 커밋하지 말고** 로컬에서 바로 지우세요: `rm github-deployer-key.json`
> (`.gitignore`에도 `*.json` 키 파일이 실수로 안 들어가도록 `github-deployer-key.json`을 추가해뒀습니다.)

**3) 끝 — 이제 `git push origin main`만 하면 자동 배포됩니다.** 저장소의 "Actions" 탭에서 진행 상황과
배포된 URL(초록 체크 → 마지막 스텝의 Summary)을 확인할 수 있습니다. 나중에 새 키를 추가하고 싶으면
GitHub Secret만 새로 등록하고 아무 커밋이나 push하면(또는 Actions 탭에서 "Run workflow" 수동 실행) 반영됩니다.

### ⑤ 물때(KHOA) API — 키 + 관측소 코드 둘 다 필요
`KHOA_TIDE_KEY`만 `.env`에 넣는다고 바로 실제 값이 나오진 않습니다. KHOA API는 위경도가 아니라
**관측소 코드(예: `DT_0001`)** 단위로 조회하는 구조라서, 어느 관측소를 쓸지 같이 알려줘야 합니다.

- 지도에서 낚시포인트 상세 패널을 열면 "물때" 섹션 아래에 "관측소 코드" 입력창이 있습니다.
- 관측소 목록(전국 60개, 코드+이름+위경도)은 [국립해양조사원_조위관측소 운영 현황](https://www.data.go.kr/data/15146602/fileData.do)에서 내려받을 수 있습니다. 여기서 보고 있는 낚시포인트와 가장 가까운 관측소의 코드를 찾아 입력창에 넣고 "조회"를 누르면 됩니다.
- 키/코드를 넣고 조회했을 때 화면에 KHOA가 돌려준 원본 응답(JSON)이 그대로 보이도록 해뒀습니다. 그 내용을 캡처해서 저에게 보여주시면, `server.js`의 `/api/tide` 응답 파싱 부분(고조/저조 시각 추출)을 정확하게 완성해드릴 수 있습니다 — 지금은 엔드포인트 URL 패턴(`/oceangrid/grid/api/.../search.do`)까지는 확인했지만, 정확한 엔드포인트명과 응답 필드명은 실제 승인된 키로 호출해봐야 확정할 수 있어서입니다.
- 매번 코드를 입력하기 번거로우면, 나중에 관측소 60개 목록을 `data/`에 넣어주시면 낚시포인트 좌표 기준으로 가장 가까운 관측소를 자동으로 매칭하도록(지금 시/도 매칭에 쓰는 방식과 동일) 코드를 추가해드릴 수 있습니다.

---

## 4. 앞으로의 확장 (생활낚시 등)

각 낚시포인트 데이터에는 이미 `lifestyleFishing` 필드가 들어있습니다 (지금은 `null`/`true` 정도만).
나중에 "생활낚시"(도심 접근성, 주차, 화장실, 초심자 난이도 등) 정보를 추가할 때는:

- `properties.lifestyleFishing`을 객체로 확장 (예: `{ parking: true, restroom: false, difficulty: "초급" }`)
- 프론트엔드 `index.html`의 "생활낚시 정보 (준비중)" 섹션과 상단 필터 체크박스가 이미 자리를 잡아두었으니, 데이터가 준비되면 해당 부분만 활성화하면 됩니다.

일본까지 확장할 계획이라면, 지도 엔진을 OSM 기반으로 유지한 채 `waterType`/`region` 스키마를 그대로 재사용해서
일본 쪽 데이터 소스(민간 낚시 정보 사이트, JMA 조석/날씨)를 같은 GeoJSON 포맷으로 추가하면 됩니다.

---

## 5. 데이터 출처 / 라이선스

- 낚시포인트(샘플): 직접 정리 (공공데이터로 교체 예정)
- 낚시포인트(공식, 교체 시): 행정안전부 전국낚시터정보표준데이터, 해양수산부 갯바위낚시포인트 (data.go.kr, 공공누리)
- 시/도 경계: 통계청(KOSTAT) 2013, via [southkorea/southkorea-maps](https://github.com/southkorea/southkorea-maps) ("free to share or remix")
- 지도 타일: © OpenStreetMap contributors
- 지도 라이브러리: Leaflet (BSD-2-Clause)
- 편의점/상점: © OpenStreetMap contributors (Overpass API)
- 날씨: 기상청 단기예보 조회서비스
- 물때: 국립해양조사원 (연동 예정)
