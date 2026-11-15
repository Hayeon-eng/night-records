"""에피소드 등록소. 새 에피소드는 별도 모듈로 추가하고 이곳에 등록합니다."""
import scenario as last_approval

SCENARIOS = {last_approval.ID: last_approval}
DEFAULT_SCENARIO_ID = last_approval.ID

def get_scenario(scenario_id=None):
    return SCENARIOS.get(scenario_id or DEFAULT_SCENARIO_ID)

def catalog():
    return [dict(id=s.ID, title=s.TITLE, summary=s.SUMMARY, players=[6,7,8], status='available',
                 duration='약 50분', theme=getattr(s,'THEME','noir')) for s in SCENARIOS.values()]
