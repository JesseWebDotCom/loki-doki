"""Safe calculator skill — AST-based math evaluation, no eval()."""
from __future__ import annotations

import ast
import math
import operator as op

from lokidoki.core.skill_executor import BaseSkill, MechanismResult

# Allow only these AST node types — no names, calls (except whitelisted), attributes.
_BIN_OPS = {
    ast.Add: op.add,
    ast.Sub: op.sub,
    ast.Mult: op.mul,
    ast.Div: op.truediv,
    ast.FloorDiv: op.floordiv,
    ast.Mod: op.mod,
    ast.Pow: op.pow,
}
_UNARY_OPS = {ast.UAdd: op.pos, ast.USub: op.neg}
_FUNCS = {
    "sqrt": math.sqrt,
    "abs": abs,
    "round": round,
    "floor": math.floor,
    "ceil": math.ceil,
    "log": math.log,
    "log2": math.log2,
    "log10": math.log10,
    "exp": math.exp,
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "min": min,
    "max": max,
    "pow": pow,
}
_CONSTS = {"pi": math.pi, "e": math.e, "tau": math.tau}


def _eval(node: ast.AST) -> float:
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, (int, float)):
            return node.value
        raise ValueError(f"unsupported constant: {node.value!r}")
    if isinstance(node, ast.BinOp):
        fn = _BIN_OPS.get(type(node.op))
        if fn is None:
            raise ValueError(f"unsupported operator: {type(node.op).__name__}")
        return fn(_eval(node.left), _eval(node.right))
    if isinstance(node, ast.UnaryOp):
        fn = _UNARY_OPS.get(type(node.op))
        if fn is None:
            raise ValueError(f"unsupported unary: {type(node.op).__name__}")
        return fn(_eval(node.operand))
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name):
            raise ValueError("only bare-name function calls allowed")
        fn = _FUNCS.get(node.func.id)
        if fn is None:
            raise ValueError(f"unknown function: {node.func.id}")
        if node.keywords:
            raise ValueError("keyword arguments not allowed")
        return fn(*[_eval(a) for a in node.args])
    if isinstance(node, ast.Name):
        if node.id in _CONSTS:
            return _CONSTS[node.id]
        raise ValueError(f"unknown name: {node.id}")
    raise ValueError(f"unsupported node: {type(node).__name__}")


def _normalize(expr: str) -> str:
    """Convert friendly forms (e.g. '15% of 240') to evaluable math."""
    s = expr.strip().rstrip("?.")
    s = s.replace("×", "*").replace("÷", "/").replace("^", "**")
    # "X% of Y"  -> "(X/100)*Y"
    import re
    s = re.sub(
        r"(\d+(?:\.\d+)?)\s*%\s*of\s*(\d+(?:\.\d+)?)",
        r"(\1/100)*\2",
        s,
        flags=re.IGNORECASE,
    )
    # bare "X%" -> "(X/100)"
    s = re.sub(r"(\d+(?:\.\d+)?)\s*%", r"(\1/100)", s)
    return s


class CalculatorSkill(BaseSkill):
    async def execute_mechanism(self, method: str, parameters: dict) -> MechanismResult:
        if method != "safe_eval":
            raise ValueError(f"Unknown mechanism: {method}")
        expr = parameters.get("expression") or parameters.get("query") or ""
        if not expr:
            return MechanismResult(success=False, error="no expression provided")
        try:
            normalized = _normalize(str(expr))
            tree = ast.parse(normalized, mode="eval")
            result = _eval(tree)
        except (SyntaxError, ValueError, ZeroDivisionError, TypeError) as exc:
            return MechanismResult(
                success=False,
                error=f"could not evaluate '{expr}': {exc}",
            )
        return MechanismResult(
            success=True,
            data={"expression": expr, "normalized": normalized, "result": result},
        )
