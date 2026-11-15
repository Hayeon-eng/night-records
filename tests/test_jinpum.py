import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine import Engine, GameError
import scenario_jinpum as J


class JinpumEpisodeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.now = 1_000_000.0
        self.engine = Engine(Path(self.tmp.name) / 'jinpum.sqlite3', lambda: self.now)

    def tearDown(self):
        self.tmp.cleanup()

    def act(self, person, action, body=None):
        return self.engine.mutate(person['code'], person['token'], action, body)

    def make_room(self, size):
        first = self.engine.create('테스터 1', size, 'normal', J.ID)
        people = [first]
        for i in range(1, size):
            people.append(self.engine.mutate(first['code'], '', 'join', {'name': f'테스터 {i+1}'}))
        return people

    def start_two_player_test(self):
        people = self.make_room(2)
        self.act(people[0], 'role', {'role': 'curator'})
        self.act(people[1], 'role', {'role': 'critic'})
        for person in people:
            state = self.act(person, 'ready')
        self.assertEqual(state['phase'], 'intro')
        self.assertEqual({m['role'] for m in state['members']}, {'curator', 'critic'})
        self.assertEqual({r['id'] for r in state['roles'] if r['required']}, {'curator', 'critic'})
        return people

    def test_two_player_coop_can_complete_episode(self):
        people = self.start_two_player_test()
        for _ in range(4):
            for person in people:
                state = self.act(person, 'vote')
        self.assertEqual(state['phase'], 'final')
        for person in people:
            state = self.act(person, 'submit', {'answers': J.ANSWERS, 'note': '테스트 정답'})
        self.assertEqual(state['phase'], 'ending')
        self.assertEqual(state['result']['grade'], 'perfect')
        self.assertEqual(state['result']['leaders'], ['auction'])
        self.assertEqual(len(state['archive']), 8)

    def test_two_player_mode_rejects_non_test_roles(self):
        people = self.make_room(2)
        with self.assertRaises(GameError):
            self.act(people[0], 'role', {'role': 'auction'})

    def test_default_catalog_is_jinpum(self):
        from scenario_registry import DEFAULT_SCENARIO_ID, get_scenario
        self.assertEqual(DEFAULT_SCENARIO_ID, J.ID)
        self.assertEqual(get_scenario().TITLE, '진품명품')
        self.assertTrue(all('name' in role for role in J.ROLES))


if __name__ == '__main__':
    unittest.main()
