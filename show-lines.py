#!/usr/bin/env python3
install_path = r'd:\Source\Project_Turing\turing-os\install\install.ps1'
with open(install_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Show the actual line 726 content
lines = content.split('\n')
for i, line in enumerate(lines[720:735], start=721):
    print(f"{i}: {repr(line)}")