"""Auto-extracted from daily_sync.py."""

import logging
import os

from local_data.db import get_db

from .base import _phase, _SCRIPT_DIR, _LOG_DIR, _TODAY, _sync_results

logger = logging.getLogger('daily_sync')

import json
import sys
# ── Phase 18: Validation ───────────────────────────────────────────────────

@_phase("validation")
def run_validation() -> dict:
    """Run data completeness validation."""
    import sync_validator
    report = sync_validator.validate_all()
    logger.info("Validation report:\n" + json.dumps(report, ensure_ascii=False, indent=2, default=str))
    _sync_results["validation"] = report

    # Check critical failures
    critical_issues = []
    for check_name, check_data in report.items():
        if isinstance(check_data, dict) and check_data.get("status") == "FAIL":
            critical_issues.append(f"{check_name}: {check_data.get('message', '')}")

    if critical_issues:
        msg = "CRITICAL VALIDATION FAILURES:\n" + "\n".join(f"  - {i}" for i in critical_issues)
        logger.error(msg)
        _sync_results["errors"].append({"phase": "validation", "error": msg})
        # Don't raise exception — let the script finish so other data is preserved

    return report

# ── Phase 19: Data Quality Sampling ─────────────────────────────────────────

@_phase("data_quality")
def run_data_quality_sampling() -> dict:
    """Run random data quality sampling via data_quality_sampler.py."""
    import subprocess

    script_path = os.path.join(_SCRIPT_DIR, "data_quality_sampler.py")
    if not os.path.exists(script_path):
        logger.warning("data_quality_sampler.py not found, skipping data quality check")
        return {"skipped": True, "reason": "script not found"}

    report_path = os.path.join(_LOG_DIR, f"data_quality_{_TODAY}.json")
    prompt_path = os.path.join(_LOG_DIR, f"data_quality_{_TODAY}_prompt.txt")

    logger.info("Running data quality random sampling (5 stocks, 3 dates each)...")
    try:
        result = subprocess.run(
            [sys.executable, script_path, "--stocks", "5", "--dates", "3", "--output", report_path],
            capture_output=True,
            text=True,
            timeout=60,
            encoding="utf-8",
        )
        if result.returncode != 0:
            logger.warning(f"data_quality_sampler.py exited with code {result.returncode}")
            logger.debug(result.stderr)
            return {"status": "failed", "returncode": result.returncode}

        # Parse summary from stdout
        stdout = result.stdout
        logger.info("Data quality sampling completed.")

        # Try to extract stock count and balance info from stdout
        stocks_checked = stdout.count("股票:")
        balanced = stdout.count("[平衡]")
        unbalanced = stdout.count("[不平衡]")

        summary = {
            "status": "success",
            "stocks_checked": stocks_checked,
            "balanced": balanced,
            "unbalanced": unbalanced,
            "report_path": report_path,
            "prompt_path": prompt_path,
        }

        if unbalanced > 0:
            logger.warning(f"Data quality: {unbalanced} unbalanced financial statements found!")
        else:
            logger.info(f"Data quality: {balanced} balanced statements checked, no issues.")

        # Save LLM prompt for manual review if needed
        if os.path.exists(report_path):
            # Generate prompt file
            try:
                import data_quality_sampler
                with open(report_path, "r", encoding="utf-8") as f:
                    report_data = json.load(f)
                prompt = data_quality_sampler.generate_llm_prompt(report_data)
                with open(prompt_path, "w", encoding="utf-8") as f:
                    f.write(prompt)
                logger.info(f"LLM prompt saved to: {prompt_path}")
            except Exception as e:
                logger.debug(f"Failed to generate LLM prompt: {e}")

        return summary
    except subprocess.TimeoutExpired:
        logger.warning("data_quality_sampler.py timed out after 60s")
        return {"status": "timeout"}
    except Exception as e:
        logger.warning(f"Data quality sampling failed: {e}")
        return {"status": "failed", "error": str(e)}


# ── Main ───────────────────────────────────────────────────────────────────
