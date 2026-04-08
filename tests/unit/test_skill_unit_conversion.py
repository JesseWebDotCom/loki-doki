import pytest

from lokidoki.skills.unit_conversion.skill import UnitConversionSkill


class TestUnitConversionSkill:
    @pytest.mark.anyio
    async def test_miles_to_km(self):
        skill = UnitConversionSkill()
        r = await skill.execute_mechanism(
            "table_lookup",
            {"value": 5, "from_unit": "miles", "to_unit": "km"},
        )
        assert r.success is True
        assert r.data["result"] == pytest.approx(8.04672, rel=1e-4)
        assert r.data["category"] == "length"

    @pytest.mark.anyio
    async def test_lbs_to_kg(self):
        skill = UnitConversionSkill()
        r = await skill.execute_mechanism(
            "table_lookup",
            {"value": 25, "from_unit": "lbs", "to_unit": "kg"},
        )
        assert r.success is True
        assert r.data["result"] == pytest.approx(11.339809, rel=1e-4)

    @pytest.mark.anyio
    async def test_temperature_f_to_c(self):
        skill = UnitConversionSkill()
        r = await skill.execute_mechanism(
            "table_lookup",
            {"value": 100, "from_unit": "fahrenheit", "to_unit": "celsius"},
        )
        assert r.success is True
        assert r.data["result"] == pytest.approx(37.7778, rel=1e-3)

    @pytest.mark.anyio
    async def test_cross_category_rejected(self):
        skill = UnitConversionSkill()
        r = await skill.execute_mechanism(
            "table_lookup",
            {"value": 5, "from_unit": "kg", "to_unit": "meters"},
        )
        assert r.success is False
        assert "cannot convert" in r.error

    @pytest.mark.anyio
    async def test_unknown_unit(self):
        skill = UnitConversionSkill()
        r = await skill.execute_mechanism(
            "table_lookup",
            {"value": 1, "from_unit": "smoots", "to_unit": "m"},
        )
        assert r.success is False

    @pytest.mark.anyio
    async def test_non_numeric_value(self):
        skill = UnitConversionSkill()
        r = await skill.execute_mechanism(
            "table_lookup",
            {"value": "abc", "from_unit": "m", "to_unit": "ft"},
        )
        assert r.success is False
