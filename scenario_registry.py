"""에피소드 등록소. 새 에피소드는 별도 모듈로 추가하고 이곳에 등록합니다."""
import scenario_jinpum2 as jinpum2
import scenario_jinpum as jinpum
import scenario as last_approval

SCENARIOS = {
    jinpum2.ID: jinpum2,
    jinpum.ID: jinpum,  # 진품명품 초기 버전: 이미 만들어진 방과의 호환용. 신규 선택 목록에는 노출하지 않음.
    last_approval.ID: last_approval,  # 기존 생성된 방/테스트 호환용. 신규 선택 목록에는 노출하지 않음.
}
DEFAULT_SCENARIO_ID = jinpum2.ID

def _players_label(players):
    # 정식 인원(6명 이상)은 범위로, 그보다 적은 인원은 테스트 모드로 표기한다.
    regular = sorted(n for n in players if n >= 6)
    test = sorted(n for n in players if n < 6)
    label = (f"{regular[0]}–{regular[-1]}명" if len(regular) > 1 else f"{regular[0]}명") if regular else ""
    if test:
        label += (" · " if label else "") + "·".join(str(n) for n in test) + "인 테스트 가능"
    return label

def catalog():
    # 신규 게임 생성 화면에는 현재 배포 대상으로 확정된 에피소드만 노출한다.
    # genre / tagline / stamp 는 시작 화면 에피소드 카드용 메타데이터다. 시나리오 모듈에 없으면 빈 값이다.
    s = SCENARIOS[DEFAULT_SCENARIO_ID]
    players = list(getattr(s, "SIZES", [2,6,7,8] if getattr(s, "TEST_REQUIRED_ROLES", None) else [6,7,8]))
    return [dict(id=s.ID, title=s.TITLE, summary=s.SUMMARY,
                 players=players, players_label=getattr(s, "PLAYERS_LABEL", None) or _players_label(players),
                 status='available', duration=getattr(s, "DURATION", None) or ('약 35분' if getattr(s, "TEST_REQUIRED_ROLES", None) else '약 50분'),
                 theme=getattr(s,'THEME','noir'),
                 genre=getattr(s,'GENRE',''), tagline=getattr(s,'TAGLINE',''), stamp=getattr(s,'STAMP',''))]

def get_scenario(scenario_id=None):
    return SCENARIOS.get(scenario_id or DEFAULT_SCENARIO_ID)
