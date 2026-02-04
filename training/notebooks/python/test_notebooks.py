#!/usr/bin/env python3
"""
Test script for running all Jupyter notebooks.
Validates that notebooks execute without errors.
"""

import subprocess
import sys
import os
from pathlib import Path

def run_notebook(notebook_path, timeout=600):
    """
    Run a Jupyter notebook and return success/failure status.
    """
    print(f"\n{'='*60}")
    print(f"Testing: {notebook_path.name}")
    print('='*60)
    
    try:
        result = subprocess.run(
            [
                sys.executable, '-m', 'jupyter', 'nbconvert',
                '--to', 'notebook',
                '--execute',
                '--ExecutePreprocessor.timeout=' + str(timeout),
                '--output', str(notebook_path.stem) + '_executed.ipynb',
                str(notebook_path)
            ],
            capture_output=True,
            text=True,
            timeout=timeout + 60,
            cwd=notebook_path.parent
        )
        
        if result.returncode == 0:
            print(f"✓ PASSED: {notebook_path.name}")
            # Clean up executed notebook
            executed_path = notebook_path.parent / (notebook_path.stem + '_executed.ipynb')
            if executed_path.exists():
                executed_path.unlink()
            return True
        else:
            print(f"✗ FAILED: {notebook_path.name}")
            print(f"STDERR: {result.stderr[:2000]}")
            return False
            
    except subprocess.TimeoutExpired:
        print(f"✗ TIMEOUT: {notebook_path.name} (>{timeout}s)")
        return False
    except Exception as e:
        print(f"✗ ERROR: {notebook_path.name} - {str(e)}")
        return False


def main():
    """
    Test all notebooks in the notebooks directory.
    """
    notebooks_dir = Path(__file__).parent
    
    # Create data directories if needed
    (notebooks_dir.parent / 'data' / 'simulated').mkdir(parents=True, exist_ok=True)
    (notebooks_dir.parent / 'models' / 'trained').mkdir(parents=True, exist_ok=True)
    
    # List of notebooks in order
    notebooks = [
        '01_data_simulation.ipynb',
        # These depend on data from 01:
        # '02_anomaly_detection.ipynb',
        # '03_rul_prediction.ipynb',
        # '04_classification.ipynb',
        # '06_transformer_models.ipynb',
        # Use case notebooks are self-contained:
        'usecase_01_pump_monitoring.ipynb',
        'usecase_02_electric_motor.ipynb',
        # 'usecase_03_bearing_rul.ipynb',  # Longer runtime
        # 'usecase_04_hvac_system.ipynb',
        # 'usecase_05_cnc_tool_wear.ipynb',
    ]
    
    results = {}
    
    for nb_name in notebooks:
        nb_path = notebooks_dir / nb_name
        if nb_path.exists():
            results[nb_name] = run_notebook(nb_path, timeout=300)
        else:
            print(f"⚠ SKIPPED: {nb_name} (not found)")
            results[nb_name] = None
    
    # Summary
    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    
    passed = sum(1 for v in results.values() if v is True)
    failed = sum(1 for v in results.values() if v is False)
    skipped = sum(1 for v in results.values() if v is None)
    
    for name, result in results.items():
        status = "✓ PASSED" if result is True else "✗ FAILED" if result is False else "⚠ SKIPPED"
        print(f"  {status}: {name}")
    
    print(f"\nTotal: {passed} passed, {failed} failed, {skipped} skipped")
    
    return 0 if failed == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
