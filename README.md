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
- [ ] [국립해양조사원_조석예보](https://www.data.go.kr/data/15038991/openapi.do) → `.env`의 `KHOA_TIDE_KEY` — 키만으론 부족하고, 관측소 코드도 같이 필요합니다 (아래 ④ 참고).
- [ ] (선택) [갯바위낚시포인트 오픈API](https://www.data.go.kr/data/15148580/fileData.do) → `.env`의 `MOF_ROCKPOINT_KEY`

> ⚠️ **`.env`는 로컬 실행(`npm start`)에서만 읽힙니다.** Cloud Run에 배포한 뒤에는 `.env` 파일이 컨테이너에 없으므로
> (`.gitignore`/`.dockerignore`에서 제외됨), 키는 반드시 ③의 `--set-env-vars` 또는 Secret Manager로 다시 넣어줘야 합니다.
> 로컬에서 키를 넣고 잘 되는 걸 확인한 다음, 같은 값을 Cloud Run에도 넣어주는 2단계라고 생각하시면 됩니다.

### ② GitHub
- [ ] 새 저장소 생성 (예: `fishing-map-kr`), **Private/Public 원하는 대로**
- [ ] 아래 명령으로 이 코드를 푸시:
  ```bash
  git remote add origin https://github.com/<your-id>/fishing-map-kr.git
  git branch -M main
  git add .
  git commit -m "Initial fishing map prototype"
  git push -u origin main
  ```
  (이 환경에는 GitHub 로그인이 연결되어 있지 않아 제가 직접 푸시할 수 없습니다. 위 명령을 직접 실행해주세요.)

### ③ Google Cloud — Cloud Run 배포 (무료 티어로 충분)
- [ ] GCP 프로젝트 생성, **빌링 계정 연결** (Cloud Run은 카드 등록은 필요하지만, 이 정도 트래픽이면 무료 한도 내에서 과금 없이 운영됩니다)
- [ ] `gcloud` CLI 설치 후 로그인: `gcloud auth login && gcloud config set project <PROJECT_ID>`
- [ ] 배포:
  ```bash
  gcloud run deploy fishing-map-kr \
    --source . \
    --region asia-northeast3 \
    --allow-unauthenticated \
    --set-env-vars KMA_FORECAST_KEY=xxxx,KHOA_TIDE_KEY=xxxx
  ```
  (키는 커밋하지 말고 위처럼 `--set-env-vars` 또는 **Secret Manager**로 주입하세요.)
- [ ] (선택, 추천) GitHub 저장소를 Cloud Build 트리거에 연결하면 `main`에 푸시할 때마다 자동 배포됩니다:
  Cloud Console → Cloud Build → 트리거 → "리포지토리 연결" → GitHub 저장소 선택 → 빌드 구성: Dockerfile

### ④ 물때(KHOA) API — 키 + 관측소 코드 둘 다 필요
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
