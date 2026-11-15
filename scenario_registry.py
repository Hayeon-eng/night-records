"""에피소드 등록소. 새 에피소드는 별도 모듈로 추가하고 이곳에 등록합니다."""
import scenario_jinpum as jinpum
import scenario as last_approval

SCENARIOS = {
    jinpum.ID: jinpum,
    last_approval.ID: last_approval,  # 기존 생성된 방/테스트 호환용. 신규 선택 목록에는 노출하지 않음.
}
DEFAULT_SCENARIO_ID = jinpum.ID

def catalog():
    # 신규 게임 생성 화면에는 현재 배포 대상으로 확정된 에피소드만 노출한다.
    s = SCENARIOS[DEFAULT_SCENARIO_ID]
    return [dict(id=s.ID, title=s.TITLE, summary=s.SUMMARY,
                 players=[2,6,7,8] if getattr(s, "TEST_REQUIRED_ROLES", None) else [6,7,8],
                 status='available', duration='약 35분' if getattr(s, "TEST_REQUIRED_ROLES", None) else '약 50분',
                 theme=getattr(s,'THEME','noir'))]

def get_scenario(scenario_id=None):
    return SCENARIOS.get(scenario_id or DEFAULT_SCENARIO_ID)
