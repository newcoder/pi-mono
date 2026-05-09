#!/usr/bin/env python3
"""Automated NotebookLM login - detects successful auth and saves state."""
import sys
import os
from pathlib import Path

# Add notebooklm to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print("[red]Playwright not installed.[/red]")
    sys.exit(1)

# Use same paths as notebooklm CLI
home = Path(os.environ.get("NOTEBOOKLM_HOME", Path.home() / ".notebooklm"))
storage_path = home / "storage_state.json"
browser_profile = home / "browser_profile"
NOTEBOOKLM_URL = "https://notebooklm.google.com"
GOOGLE_ACCOUNTS_URL = "https://accounts.google.com"

storage_path.parent.mkdir(parents=True, exist_ok=True)
browser_profile.mkdir(parents=True, exist_ok=True)

print("Opening browser for Google login...")
print(f"Profile: {browser_profile}")
print()
print("Please complete Google login in the browser window.")
print("Waiting for you to reach NotebookLM homepage...")
print()

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        user_data_dir=str(browser_profile),
        headless=False,
        args=[
            "--disable-blink-features=AutomationControlled",
            "--password-store=basic",
        ],
        ignore_default_args=["--enable-automation"],
    )

    page = context.pages[0] if context.pages else context.new_page()
    page.goto(NOTEBOOKLM_URL)

    # Wait for the page to reach notebooklm.google.com (after login redirect)
    MAX_WAIT = 600  # 10 minutes max
    elapsed = 0
    while elapsed < MAX_WAIT:
        url = page.url
        if "notebooklm.google.com" in url and "accounts.google.com" not in url:
            print("✅ Detected NotebookLM homepage!")
            break
        page.wait_for_timeout(2000)
        elapsed += 2
    else:
        print("⚠️ Timeout waiting for login. Saving current state anyway...")

    # Force .google.com cookies
    page.goto(GOOGLE_ACCOUNTS_URL, wait_until="load")
    page.goto(NOTEBOOKLM_URL, wait_until="load")

    # Save auth
    context.storage_state(path=str(storage_path))
    storage_path.chmod(0o600)
    context.close()

print(f"✅ Authentication saved to: {storage_path}")
print("You can now use notebooklm commands!")
