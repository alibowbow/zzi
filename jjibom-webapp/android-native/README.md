# 찌봄 진동 감지 — 안드로이드 설치형 앱 (Capacitor + Foreground Service)

이 폴더는 **백그라운드(다른 앱 사용·화면 꺼짐) 진동 감지**를 위한 안드로이드 네이티브 소스입니다.
Capacitor로 웹 UI를 그대로 감싸고, 커스텀 Kotlin **Foreground Service**가 센서 감지를 담당합니다.

> ⚠️ 이 저장소 환경에서는 Android SDK/Gradle이 없어 **컴파일·APK 생성을 실행하지 못했습니다.**
> 아래 절차대로 로컬(Android Studio)에서 빌드하세요. 코드는 Capacitor 6 / Android 13–14 기준으로 작성했습니다.

## 들어 있는 파일과 복사 위치

`npx cap add android` 로 생성되는 `android/` 프로젝트에 아래처럼 배치합니다. 모든 Kotlin 파일의 패키지는 `app.jjibom.motion`(= appId) 입니다.

| 이 폴더의 파일 | 복사 위치 |
| --- | --- |
| `JjibomMotionPlugin.kt` | `android/app/src/main/java/app/jjibom/motion/` |
| `VibrationDetectionService.kt` | `android/app/src/main/java/app/jjibom/motion/` |
| `MotionSignalProcessor.kt` | `android/app/src/main/java/app/jjibom/motion/` |
| `MonitoringNotification.kt` | `android/app/src/main/java/app/jjibom/motion/` |
| `MainActivity.kt` | 생성된 `MainActivity.kt` 를 **이 내용으로 교체** |
| `AndroidManifest-additions.xml` | `AndroidManifest.xml` 에 **병합** |

## 빌드 절차

```bash
# 0) 사전: Node 18+, Android Studio(SDK + Platform 34), JDK 17

cd jjibom-webapp
npm install                 # @capacitor/core, /cli, /android 설치

# 1) 정적 웹 자산을 www/ 로 복사 (이 프로젝트는 번들러가 없습니다)
npm run build:web

# 2) 안드로이드 플랫폼 추가 (최초 1회)
npx cap add android

# 3) 위 표대로 Kotlin/Manifest 파일을 복사·병합

# 4) 웹 자산 동기화
npm run cap:sync            # = build:web + cap sync android

# 5) Android Studio 열기 → 실행 또는 APK 빌드
npm run cap:open            # Android Studio 실행
```

### 디버그 APK 만들기 (CLI)

```bash
cd android
./gradlew assembleDebug
# 결과물: android/app/build/outputs/apk/debug/app-debug.apk

# 기기에 설치
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## 권한과 이유

| 권한 | 이유 |
| --- | --- |
| `FOREGROUND_SERVICE` | 화면을 벗어나도 감지를 유지하는 포그라운드 서비스 |
| `FOREGROUND_SERVICE_SPECIAL_USE` | Android 14+ 필수. 전용 FGS 유형이 없는 사용 사례라 `specialUse` 사용 |
| `POST_NOTIFICATIONS` | 지속 알림 + 입질 알림 (Android 13+ 런타임 권한) |
| `VIBRATE` | 입질 알림 진동 |
| `WAKE_LOCK` | 화면 꺼짐 중 CPU 유지(PARTIAL_WAKE_LOCK), 감시 중에만 획득 |

**요청하지 않는 권한:** 위치·마이크·카메라·`BODY_SENSORS`. 가속도/자이로는 별도 권한이 필요 없습니다.

### Android 14+ specialUse 선언

서비스에 `android:foregroundServiceType="specialUse"` 와 `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` 설명을 넣었습니다.
Google Play 출시 시 Play Console에서 specialUse 사용 사유를 별도로 제출해야 할 수 있습니다. `health` 등 다른 유형으로 위장하지 마세요.

## 센서 우선순위

1. `TYPE_LINEAR_ACCELERATION` (중력 제거된 선형 가속도)
2. `TYPE_ACCELEROMETER` (+ `TYPE_GRAVITY` 로 중력 추정·제거)
3. `TYPE_GYROSCOPE` (보조)

모든 기기에 모든 센서가 있다고 가정하지 않습니다. `getAvailableSensors()` 로 확인합니다. 샘플 주기는 `SENSOR_DELAY_GAME`(~50Hz).

## 화면 꺼짐 / 절전

- 감시 중에만 `PARTIAL_WAKE_LOCK` 을 획득하고, 일시정지·종료·`onDestroy` 에서 즉시 해제합니다(중복 획득 방지, 6시간 타임아웃).
- 그래도 **제조사별 절전 정책**(삼성·샤오미 등)으로 화면이 오래 꺼지면 센서 전달이 느려지거나 멈출 수 있습니다. 필요 시 사용자가 직접 “배터리 최적화 제외”를 켜도록 안내하세요(강제 요청 금지).
- 재부팅 자동 시작·강제 종료 후 지속은 **약속하지 않습니다.** 서비스는 사용자가 앱에서 시작 버튼을 눌렀을 때만 시작합니다.

## 웹과의 동기화

웹 UI(`src/nativeBridge.js`)는 `Capacitor.Plugins.JjibomMotion` 을 통해 서비스를 제어하고 `stateChanged / biteDetected / metrics / sensorError` 이벤트를 구독합니다. 앱을 다시 열면 `getMonitoringState()` 로 실제 서비스 상태를 복원합니다(웹 UI 상태가 아니라 서비스 상태가 기준).

## 알림

- **지속 알림**(IMPORTANCE_LOW): “찌봄이 입질을 감시하고 있어요”, 액션 = 일시정지 / 다시시작 / 종료, 탭하면 앱 열기.
- **입질 알림**(IMPORTANCE_HIGH, heads-up): “입질 감지!”, 패턴·시각·강도. Full Screen Intent 미사용, 방해금지 우회 안 함.

## 자기 진동 재감지 방지

알람 진동을 울리기 **직전**에 `processor.muteForSelfVibration(now)` 로 판정을 음소거하고, 쿨다운 동안 새 알람을 금지합니다. 테스트 알람은 실제 입질로 기록하지 않습니다. (웹/네이티브 중 한쪽만 알람 소유 — 네이티브 실행 시 웹 판정기는 동작하지 않습니다.)

## 남은 검증 항목 (실기기 필요)

- 화면 끄고 10분+ 후에도 센서 이벤트 수신 여부(기기별 상이)
- 알림 액션(일시정지/종료) 동작
- 다른 앱 실행 중 지속 알림 유지
- 앱 재실행 시 상태 복원
- 권한 거부/센서 없는 기기 처리
- 종료 시 WakeLock·리스너 해제(Logcat 확인)
- 1시간당 배터리 소모 측정
