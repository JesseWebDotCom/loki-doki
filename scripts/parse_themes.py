import json
import re

with open('themes_page.html', 'r') as f:
    content = f.read()

# Try to find JSON-like structures in the HTML
# In modern apps, it's often in a script tag.
# Let's find all script tags.
scripts = re.findall(r'<script[^>]*>(.*?)</script>', content, re.DOTALL)

for i, script in enumerate(scripts):
    if '"themes"' in script or '"id":"northern-lights"' in script:
        print(f"Found potential theme data in script {i}")
        # Extract the JSON part. It might be a large object.
        # Sometimes it's double-encoded or Escaped.
        try:
            # Look for the start of the object
            start = script.find('{')
            end = script.rfind('}') + 1
            if start != -1 and end != -1:
                obj_str = script[start:end]
                # Try to load it
                # data = json.loads(obj_str)
                # If it's a huge file, maybe we should just grep for the theme ids.
                pass
        except:
            pass

# Actually, the quickest way to get the data if it's there is to grep for the theme pattern.
# Theme structure might be: {"id":"northern-lights","name":"Northern Lights",...}
# Let's search for this pattern and see what follows.
pattern = r'{"\$id":"theme/([^"]+)","type":"page","name":"([^"]+)","description":"([^"]+)"'
matches = re.findall(pattern, content)

themes = []
for slug, name, desc in matches:
    themes.append({"id": slug, "name": name, "desc": desc})

print(f"Found {len(themes)} themes")
for t in themes[:5]:
    print(t)
