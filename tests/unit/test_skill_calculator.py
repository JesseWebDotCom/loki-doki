import math

import pytest

from lokidoki.skills.calculator.skill import CalculatorSkill


class TestCalculatorSkill:
    @pytest.mark.anyio
    async def test_basic_arithmetic(self):
        skill = CalculatorSkill()
        r = await skill.execute_mechanism("safe_eval", {"expression": "2 + 3 * 4"})
        assert r.success is True
        assert r.data["result"] == 14

    @pytest.mark.anyio
    async def test_percentage_of(self):
        skill = CalculatorSkill()
        r = await skill.execute_mechanism("safe_eval", {"expression": "15% of 240"})
        assert r.success is True
        assert r.data["result"] == pytest.approx(36.0)

    @pytest.mark.anyio
    async def test_function_call(self):
        skill = CalculatorSkill()
        r = await skill.execute_mechanism("safe_eval", {"expression": "sqrt(144)"})
        assert r.success is True
        assert r.data["result"] == 12

    @pytest.mark.anyio
    async def test_constants(self):
        skill = CalculatorSkill()
        r = await skill.execute_mechanism("safe_eval", {"expression": "pi * 2"})
        assert r.success is True
        assert r.data["result"] == pytest.approx(math.pi * 2)

    @pytest.mark.anyio
    async def test_unicode_operators(self):
        skill = CalculatorSkill()
        r = await skill.execute_mechanism("safe_eval", {"expression": "12 × 3"})
        assert r.success is True
        assert r.data["result"] == 36

    @pytest.mark.anyio
    async def test_division_by_zero(self):
        skill = CalculatorSkill()
        r = await skill.execute_mechanism("safe_eval", {"expression": "1/0"})
        assert r.success is False

    @pytest.mark.anyio
    async def test_rejects_arbitrary_names(self):
        # Must NOT execute arbitrary code via name lookup.
        skill = CalculatorSkill()
        r = await skill.execute_mechanism("safe_eval", {"expression": "__import__('os')"})
        assert r.success is False

    @pytest.mark.anyio
    async def test_empty_expression(self):
        skill = CalculatorSkill()
        r = await skill.execute_mechanism("safe_eval", {"expression": ""})
        assert r.success is False

    @pytest.mark.anyio
    async def test_unknown_mechanism_raises(self):
        skill = CalculatorSkill()
        with pytest.raises(ValueError):
            await skill.execute_mechanism("nope", {"expression": "1+1"})
