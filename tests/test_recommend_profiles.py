import pytest
from djtoolkit.recommend.profiles import (
    merge_profiles,
    apply_lineup_modifier,
    build_context_profile,
    LINEUP_MODIFIERS,
)


class TestLineupModifiers:
    def test_warmup_energy_multiplier(self):
        assert LINEUP_MODIFIERS["warmup"]["energy_multiplier"] == 0.6

    def test_headliner_energy_multiplier(self):
        assert LINEUP_MODIFIERS["headliner"]["energy_multiplier"] == 1.1

    def test_middle_energy_multiplier(self):
        assert LINEUP_MODIFIERS["middle"]["energy_multiplier"] == 0.85


class TestMergeProfiles:
    def test_single_profile(self):
        venue = {"bpm": [126, 140], "energy": [0.7, 0.95]}
        result = merge_profiles(venue, None)
        assert result == {"bpm": [126, 140], "energy": [0.7, 0.95]}

    def test_single_mood_profile(self):
        mood = {"bpm": [110, 125], "energy": [0.3, 0.6]}
        result = merge_profiles(None, mood)
        assert result == {"bpm": [110, 125], "energy": [0.3, 0.6]}

    def test_overlapping_ranges_intersect(self):
        venue = {"bpm": [120, 140], "energy": [0.6, 0.9]}
        mood = {"bpm": [125, 135], "energy": [0.5, 0.8]}
        result = merge_profiles(venue, mood)
        assert result["bpm"] == [125, 135]  # intersection
        assert result["energy"] == [0.6, 0.8]  # intersection

    def test_non_overlapping_ranges_use_midpoint(self):
        venue = {"bpm": [126, 140]}
        mood = {"bpm": [110, 125]}
        result = merge_profiles(venue, mood)
        # midpoint between 125 and 126 is 125.5, ±5 window
        assert result["bpm"] == [120.5, 130.5]

    def test_genres_union(self):
        venue = {"bpm": [120, 140], "genres": ["techno", "house"]}
        mood = {"bpm": [125, 135], "genres": ["house", "minimal"]}
        result = merge_profiles(venue, mood)
        assert set(result["genres"]) == {"techno", "house", "minimal"}

    def test_both_none_raises(self):
        with pytest.raises(ValueError, match="At least one profile"):
            merge_profiles(None, None)


class TestApplyLineupModifier:
    def test_warmup_scales_energy_down(self):
        profile = {"bpm": [125, 140], "energy": [0.6, 0.9]}
        result = apply_lineup_modifier(profile, "warmup")
        assert result["energy"] == [pytest.approx(0.36), pytest.approx(0.54)]

    def test_warmup_biases_bpm_lower(self):
        profile = {"bpm": [125, 140]}
        result = apply_lineup_modifier(profile, "warmup")
        assert result["bpm"][0] < 125  # shifted lower
        assert result["bpm"][1] < 140

    def test_headliner_scales_energy_up(self):
        profile = {"bpm": [125, 140], "energy": [0.6, 0.9]}
        result = apply_lineup_modifier(profile, "headliner")
        assert result["energy"][0] > 0.6
        # energy capped at 1.0
        assert result["energy"][1] <= 1.0

    def test_headliner_biases_bpm_upper(self):
        profile = {"bpm": [125, 140]}
        result = apply_lineup_modifier(profile, "headliner")
        assert result["bpm"][0] > 125
        assert result["bpm"][1] > 140

    def test_middle_moderate(self):
        profile = {"bpm": [125, 140], "energy": [0.6, 0.9]}
        result = apply_lineup_modifier(profile, "middle")
        assert result["energy"] == [pytest.approx(0.51), pytest.approx(0.765)]

    def test_preserves_non_numeric_fields(self):
        profile = {"bpm": [125, 140], "genres": ["techno"]}
        result = apply_lineup_modifier(profile, "warmup")
        assert result["genres"] == ["techno"]


class TestBuildContextProfile:
    def test_venue_only_with_lineup(self):
        venue_profile = {"bpm": [126, 140], "energy": [0.7, 0.95]}
        result = build_context_profile(venue_profile, None, "middle")
        assert "bpm" in result
        assert "energy" in result

    def test_mood_only_with_lineup(self):
        mood_profile = {"bpm": [110, 125], "energy": [0.3, 0.6]}
        result = build_context_profile(None, mood_profile, "warmup")
        assert "bpm" in result
        assert "energy" in result
