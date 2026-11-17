// The trial's fixed scenario, re-derived at runtime from the contest's one
// constant seed. The env builds its whole scenario (users, repos, titles)
// from SCENARIO_SEED and never from the trial, so the viewer login below is
// the same for every trial, practice or scored. This is a port of the kit's
// wire.ts scenarioRng/generateUsers (xorshift64* + FNV-1a + splitmix64
// finalizer) — the only part the forge needs is the viewer (users[0]).
// Verified against the kit's buildScenario(): viewer login "adaiversen",
// stranger "olgabauer".
//
// Port of the Node forge's scenario.ts.

package main

import (
	"regexp"
	"strconv"
)

const scenarioSeed uint64 = 0x6a09e667f3bcc909

func fnv1a64(text string) uint64 {
	hash := uint64(0xcbf29ce484222325)
	for i := 0; i < len(text); i++ {
		hash ^= uint64(text[i])
		hash *= 0x100000001b3
	}
	return hash
}

func mix64(value uint64) uint64 {
	z := value + 0x9e3779b97f4a7c15
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

type rng struct {
	state uint64
}

func newRng(seed uint64) *rng {
	if seed == 0 {
		seed = scenarioSeed
	}
	return &rng{state: seed}
}

func (r *rng) nextU64() uint64 {
	x := r.state
	x ^= x >> 12
	x ^= x << 25
	x ^= x >> 27
	r.state = x
	return x * 0x2545f4914f6cdd1d
}

func (r *rng) nextU32() uint32 {
	return uint32(r.nextU64() >> 32)
}

func (r *rng) nextInt(maxExclusive int) int {
	if maxExclusive == 1 {
		return 0
	}
	const range32 = 4294967296
	limit := range32 - (range32 % uint64(maxExclusive))
	for {
		v := r.nextU32()
		if uint64(v) < limit {
			return int(v) % maxExclusive
		}
	}
}

func (r *rng) pick(items []string) string {
	return items[r.nextInt(len(items))]
}

var firstNames = []string{
	"ada", "bram", "cora", "dmitri", "elena", "felix", "greta", "hugo", "iris", "jonas", "kira", "lars",
	"mira", "nico", "olga", "pavel", "quinn", "rosa", "sven", "tess", "ulla", "vito", "wren", "yara", "zane",
}

var lastNames = []string{
	"anders", "bauer", "costa", "dahl", "eriksen", "fischer", "garcia", "holm", "iversen", "jansen", "keller",
	"lind", "moreau", "novak", "olsen", "peters", "quist", "rossi", "sato", "turi", "ulrich", "vega", "weber",
	"xu", "yilmaz", "zimmer",
}

var nonLogin = regexp.MustCompile(`[^a-z0-9-]`)

func cleanLogin(s string) string {
	return nonLogin.ReplaceAllString(s, "")
}

// viewerLogin returns the login the trial's token names (the scenario's first user).
func viewerLogin() string {
	r := newRng(mix64(scenarioSeed ^ fnv1a64("users")))
	first := r.pick(firstNames)
	last := r.pick(lastNames)
	return cleanLogin(first + last)
}

// strangerLogin returns the stranger's login (users[2]) — a repo under this owner is 404, never 403.
func strangerLogin() string {
	r := newRng(mix64(scenarioSeed ^ fnv1a64("users")))
	used := map[string]bool{}
	login := ""
	for i := 0; i < 3; i++ {
		first := r.pick(firstNames)
		last := r.pick(lastNames)
		candidate := cleanLogin(first + last)
		suffix := 2
		for used[candidate] {
			candidate = cleanLogin(first+last) + "-" + strconv.Itoa(suffix)
			suffix++
		}
		used[candidate] = true
		login = candidate
	}
	return login
}
