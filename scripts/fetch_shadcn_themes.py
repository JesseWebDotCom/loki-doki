import requests
import json
import re

slugs = [
    "amber-minimal", "amethyst-haze", "art-deco", "blue", "bold-tech", "bubblegum", "caffeine", "candyland", 
    "catppuccin", "claude", "claymorphism", "clean-slate", "corporate", "cosmic-night", "cyberpunk", 
    "darkmatter", "doom-64", "elegant-luxury", "ghibli-studio", "graphite", "green", "kodama-grove", 
    "marshmallow", "marvel", "material-design", "midnight-bloom", "mocha-mousse", "modern-minimal", 
    "mono", "nature", "neo-brutalism", "northern-lights", "notebook", "ocean-breeze", "orange", 
    "pastel-dreams", "perpetuity", "quantum-rose", "red", "retro-arcade", "rose", "slack", "soft-pop", 
    "solar-dusk", "spotify", "starry-night", "summer", "sunset-horizon", "supabase", "t3-chat", 
    "tangerine", "twitter", "valorant", "vercel", "vintage-paper", "violet", "violet-bloom", "vs-code", "yellow"
]

def clean_label(slug):
    return " ".join(word.capitalize() for word in slug.split("-"))

def fetch_theme(slug):
    url = f"https://www.shadcn.io/r/{slug}.json"
    try:
        response = requests.get(url)
        if response.status_code == 200:
            data = response.json()
            # The JSON structure seems to contain registry info.
            # We need the actual theme variables.
            # Looking at how shadcn registry works, the variables are often in 'cssVars' field.
            # Let's try to find it.
            return data
        else:
            print(f"Failed to fetch {slug}: {response.status_code}")
            return None
    except Exception as e:
        print(f"Error fetching {slug}: {e}")
        return None

results = []
for slug in slugs:
    print(f"Fetching {slug}...")
    theme_data = fetch_theme(slug)
    if theme_data:
        # Based on the user's provided code for Northern Lights,
        # it seems they want the oklch/hsl values.
        # But wait, the registry JSON might not have exactly what we want if it's just a component registry.
        # Actually, let's look at the example the user gave again.
        # It's a React component that exports a themeConfig.
        
        # If the JSON doesn't work, I'll have to scrape the page.
        # Let's try to get the variables from the preview page instead using a simpler method.
        pass

# Since I don't know the exact structure of shadcn.io/r/*.json yet,
# I'll just scrape the preview pages directly using requests if they are static.
# If they are dynamic, I'll use the browser subagent to get them all in one big JS script.

# Actually, the quickest way to get ALL of them reliably is to run a script in the browser that:
# 1. Lists all slugs.
# 2. For each, opens the preview page or fetches it.
# 3. Extracts the CSS variables.
# 4. Returns the JSON.

# I already have the slugs. I'll use the browser subagent one more time with a script that handles ALL of them.
# I'll make sure it returns the JSON directly.
