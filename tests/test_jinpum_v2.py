import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import Engine, GameError
import scenario_jinpum2 as J


class JinpumV2Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.now = 1_000_000.0
        self.e = Engine(Path(self.tmp.name) / 'v2.sqlite3', lambda: self.now)

    def tearDown(self):
        self.tmp.cleanup()

    # ---- helpers ------------------------------------------------------------------------------
    def act(self, p, action, body=None):
        return self.e.mutate(p['code'], p['token'], action, body)

    def state(self, p):
        return self.act(p, 'state')

    def make(self, size):
        first = self.e.create('참가자 0', size, 'normal', J.ID)
        people = [first]
        for i in range(1, size):
            people.append(self.e.mutate(first['code'], '', 'join', {'name': f'참가자 {i}'}))
        return people

    def start(self, size):
        people = self.make(size)
        for p, rid in zip(people, J.REQUIRED_BY_SIZE[size]):
            p['role'] = rid
            self.act(p, 'role', {'role': rid})
        for p in people:
            st = self.act(p, 'ready')
        self.assertEqual(st['phase'], 'intro')
        return people

    def next_phase(self, people):
        for p in people:
            st = self.act(p, 'vote')
        return st

    def to_phase(self, people, phase):
        order = [x[0] for x in J.PHASES]
        st = self.state(people[0])
        while st['phase'] != phase:
            st = self.next_phase(people)
            self.assertLess(order.index(st['phase']), len(order))
        return st

    def finish(self, people, answers=None):
        self.to_phase(people, 'final')
        for p in people:
            st = self.act(p, 'submit', {'answers': answers or J.ANSWERS, 'note': ''})
        return st

    def owner(self, people, role):
        return next(p for p in people if p['role'] == role)

    # ---- 구성 · 인원 ----------------------------------------------------------------------------
    def test_sizes_and_fixed_role_sets_follow_the_bible(self):
        self.assertEqual(J.SIZES, (2, 4, 5, 6, 7, 8))
        self.assertEqual(J.REQUIRED_BY_SIZE[4], ['artist', 'heiress', 'curator', 'investor'])
        self.assertEqual(J.REQUIRED_BY_SIZE[5][-1], 'auction')
        self.assertEqual(J.REQUIRED_BY_SIZE[6][-1], 'critic')
        self.assertEqual(J.REQUIRED_BY_SIZE[7][-1], 'unknown')
        self.assertEqual(set(J.REQUIRED_BY_SIZE[8]), {r['id'] for r in J.ROLES})
        for size in J.SIZES:
            self.assertIn('curator', J.REQUIRED_BY_SIZE[size])  # 윤 큐레는 항상 플레이어
        for bad in (1, 3, 9, '4', None):
            with self.assertRaises(GameError):
                self.e.create('x', bad, 'normal', J.ID)

    def test_role_choice_is_limited_to_the_size_set(self):
        people = self.make(4)
        with self.assertRaises(GameError):
            self.act(people[0], 'role', {'role': 'critic'})  # 4인에서는 NPC
        st = self.act(people[0], 'role', {'role': 'curator'})
        roles = {r['id']: r for r in st['roles']}
        self.assertTrue(roles['curator']['selectable'])
        self.assertFalse(roles['critic']['selectable'])
        self.assertEqual(len(st['roles']), 8)  # 강태식은 선택 목록에 없다

    def test_cannot_start_until_every_set_role_is_taken(self):
        people = self.make(4)
        for p, rid in zip(people[:3], J.REQUIRED_BY_SIZE[4]):
            self.act(p, 'role', {'role': rid})
        for p in people[:3]:
            st = self.act(p, 'ready')
        self.assertEqual(st['phase'], 'lobby')

    def test_full_game_perfect_for_every_size(self):
        for size in J.SIZES:
            with self.subTest(size=size):
                st = self.finish(self.start(size))
                self.assertEqual(st['phase'], 'ending')
                r = st['result']
                self.assertEqual(r['grade'], 'perfect')
                self.assertEqual((r['average'], r['max_score']), (100, 100))
                self.assertEqual(r['title'], '완벽한 진실')
                self.assertEqual(len(st['archive']), 8)

    # ---- 토큰 ----------------------------------------------------------------------------------
    def test_token_economy_reveal_mode(self):
        people = self.start(4)
        art = self.owner(people, 'artist')
        self.assertEqual(self.state(art)['me']['tokens'], 2)
        st = self.to_phase(people, 'r1')
        self.assertEqual((st['me']['tokens'], st['me']['tokens_total']), (3, 3))
        self.assertEqual(st['scenario_meta']['token_mode'], 'reveal')
        # 내 봉인 기록은 읽을 수 있고, 남의 기록은 열 수 없다
        own = [c for c in self.state(art)['clues'] if c.get('own')]
        self.assertEqual({c['id'] for c in own}, {'artist-1', 'artist-2'})
        with self.assertRaises(GameError):
            self.act(art, 'investigate', {'clue': 'curator-1'})
        # 일부에게만 보여주기는 무료
        other = self.owner(people, 'heiress')
        self.act(art, 'share', {'clue': 'artist-1', 'to': [other['member_id']] if 'member_id' in other else [self.state(other)['me']['id']]})
        self.assertEqual(self.state(art)['me']['tokens'], 3)
        # 전체 공개는 토큰 1개
        self.act(art, 'share', {'clue': 'artist-2', 'to': 'all'})
        self.assertEqual(self.state(art)['me']['tokens'], 2)
        self.assertIn('artist-2', {c['id'] for c in self.state(self.owner(people, 'curator'))['clues']})
        # 남의 기록은 공개할 수 없다
        with self.assertRaises(GameError):
            self.act(self.owner(people, 'curator'), 'share', {'clue': 'artist-1', 'to': 'all'})

    def test_public_reveal_needs_a_token(self):
        people = self.start(4)
        art = self.owner(people, 'artist')
        self.to_phase(people, 'r1')
        self.act(art, 'share', {'clue': 'artist-1', 'to': 'all'})
        self.act(art, 'share', {'clue': 'artist-2', 'to': 'all'})
        # 토큰이 남아 있어도 이미 공개한 기록을 다시 열 수는 없다 / 토큰 3 → 1
        self.assertEqual(self.state(art)['me']['tokens'], 1)

    def test_no_reveal_before_first_investigation_round(self):
        people = self.start(4)
        with self.assertRaises(GameError):
            self.act(self.owner(people, 'artist'), 'share', {'clue': 'artist-1', 'to': 'all'})

    # ---- 증거 · NPC ---------------------------------------------------------------------------
    def test_evidence_unlocks_by_phase(self):
        people = self.start(8)
        ids = lambda st: [e['id'] for e in st['evidence']]
        self.assertEqual(ids(self.state(people[0])), [])
        self.assertEqual(ids(self.to_phase(people, 'r1')), ['e01', 'e02', 'e03', 'e04'])
        self.assertEqual(ids(self.to_phase(people, 'r2')), ['e01', 'e02', 'e03', 'e04'])  # 8인: NPC 없음
        self.assertEqual(ids(self.to_phase(people, 'r3')), [f'e0{i}' for i in range(1, 10)])

    def test_npc_records_open_in_round_three_only_for_unplayed_roles(self):
        people = self.start(4)
        self.to_phase(people, 'r1')
        self.assertFalse([e for e in self.state(people[0])['evidence'] if e['id'].startswith('n-')])
        st = self.to_phase(people, 'r2')
        npc = sorted(e['id'] for e in st['evidence'] if e['id'].startswith('n-'))
        self.assertEqual(npc, ['n-analyst', 'n-auction', 'n-critic', 'n-unknown'])
        st = self.to_phase(self.start(6), 'r2')
        npc = sorted(e['id'] for e in st['evidence'] if e['id'].startswith('n-'))
        self.assertEqual(npc, ['n-analyst', 'n-unknown'])

    # ---- 비밀 은닉 -------------------------------------------------------------------------------
    def test_final_secret_and_truth_stay_hidden_until_ending(self):
        people = self.start(4)
        for phase in ('intro', 'r1', 'r2', 'r3', 'final'):
            st = self.to_phase(people, phase)
            blob = json.dumps(st, ensure_ascii=False)
            self.assertNotIn('final', st['book'] or {})
            self.assertNotIn(J.TRUTH[-1], blob)
            self.assertFalse(st.get('archive'))
        st = self.finish(people)
        self.assertIn('final', st['book'])
        self.assertTrue(all('final' in r for r in st['archive']))

    def test_lobby_exposes_no_spoilers(self):
        people = self.make(4)
        st = self.state(people[0])
        blob = json.dumps(st, ensure_ascii=False)
        for secret in ('청동 조형물 《균열》로 강태식을 가격', '한 번 가격했다', '내연 관계', J.TRUTH[-1]):
            self.assertNotIn(secret, blob)
        self.assertTrue(all('final' not in r and 'story' not in r for r in st['roles']))
        self.assertIsNone(st['book'])
        for r in J.ROLES:
            self.assertNotIn('범인', r['teaser'] + r['public'])

    # ---- 채점 · 엔딩 ------------------------------------------------------------------------------
    def test_scoring_is_weighted_and_totals_100(self):
        self.assertEqual(sum(J.POINTS.values()), 100)
        wrong = {k: next(o['id'] for o in q['options'] if o['id'] != J.ANSWERS[k]) for k, q in ((q['id'], q) for q in J.QUESTIONS)}
        answers = dict(wrong, culprit='curator')
        st = self.finish(self.start(4), answers)
        self.assertEqual(st['result']['scores'][0]['score'], 30)
        self.assertEqual(st['result']['grade'], 'true')  # 범인은 맞혔지만 사기극 구조는 놓침

    def test_wrong_culprit_and_ties(self):
        st = self.finish(self.start(4), dict(J.ANSWERS, culprit='artist'))
        self.assertEqual(st['result']['grade'], 'bad')
        self.assertEqual(st['result']['accused'] is not None, True)
        people = self.start(4)
        self.to_phase(people, 'final')
        for i, p in enumerate(people):
            st = self.act(p, 'submit', {'answers': dict(J.ANSWERS, culprit='curator' if i % 2 else 'artist'), 'note': ''})
        self.assertEqual(st['result']['grade'], 'unresolved')
        self.assertEqual(st['result']['title'], '모두가 침묵했다')

    def test_submit_requires_every_item(self):
        people = self.start(4)
        self.to_phase(people, 'final')
        partial = dict(J.ANSWERS)
        partial.pop('roles')
        with self.assertRaises(GameError):
            self.act(people[0], 'submit', {'answers': partial, 'note': ''})

    # ---- 시나리오 데이터 정합성 ---------------------------------------------------------------------------
    def test_every_answer_can_be_deduced_from_common_evidence(self):
        ids = {c['id'] for c in J.CLUES} | {e['id'] for e in J.EVIDENCE}
        common = {e['id'] for e in J.EVIDENCE if not e.get('npc')}
        self.assertEqual(set(J.DEPENDENCIES), set(J.ANSWERS))
        for key, deps in J.DEPENDENCIES.items():
            self.assertTrue(set(deps) <= ids, key)
            self.assertTrue(set(deps) & common, f'{key}: 공통 증거만으로도 단서가 있어야 한다')
        # 범인에게만 있는 결정적 증거가 없어야 한다: 범인 추리는 공통 증거로 성립한다
        self.assertTrue({'e04', 'e08', 'e09'} <= set(J.DEPENDENCIES['culprit']))

    def test_data_shape(self):
        self.assertEqual(len(J.ROLES), 8)
        self.assertEqual(len(J.CLUES), 16)
        for r in J.ROLES:
            self.assertEqual(len([c for c in J.CLUES if c['owner'] == r['id']]), 2, r['id'])
            self.assertEqual(len(r['secret']), 2, r['id'])
            self.assertTrue(r['final'] and r['story'] and r['timeline'] and r['mission'], r['id'])
        self.assertEqual([e['id'] for e in J.EVIDENCE if e['phase'] == 'r1'], ['e01', 'e02', 'e03', 'e04'])
        self.assertEqual(len([e for e in J.EVIDENCE if e['phase'] == 'r3']), 5)
        self.assertEqual(set(J.ENDING), {'perfect', 'true', 'bad', 'unresolved'})
        self.assertEqual(set(J.ANSWERS.values()) <= {o['id'] for q in J.QUESTIONS for o in q['options']}, True)
        # 문서의 실제 타임라인 핵심 시각
        times = dict((t, x) for t, x in J.NIGHT_TIMELINE)
        for t in ('20:45', '21:07', '21:10', '21:20', '21:45'):
            self.assertIn(t, times)


if __name__ == '__main__':
    unittest.main()
