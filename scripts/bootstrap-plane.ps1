param(
    [string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

$ErrorActionPreference = 'Stop'

function Get-EnvMap {
    param([string]$EnvFile)
    $envMap = [ordered]@{}
    if (-not (Test-Path $EnvFile)) { return $envMap }
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
        $key, $value = $_ -split '=', 2
        $envMap[$key.Trim()] = $value.Trim()
    }
    return $envMap
}

function Upsert-EnvValue {
    param([string]$EnvFile, [string]$Key, [string]$Value)
    $escapedKey = [regex]::Escape($Key)
    $lines = if (Test-Path $EnvFile) { Get-Content $EnvFile } else { @() }
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match "^${escapedKey}=") {
            $lines[$i] = "${Key}=${Value}"
            Set-Content -Path $EnvFile -Value $lines
            return
        }
    }
    $lines += "${Key}=${Value}"
    Set-Content -Path $EnvFile -Value $lines
}

$envFile = Join-Path $RepoRoot '.env'
$envMap = Get-EnvMap -EnvFile $envFile

$planeAdminEmail   = if ($envMap.PLANE_ADMIN_EMAIL)   { $envMap.PLANE_ADMIN_EMAIL }   else { 'admin@turing.local' }
$planeAdminPass    = if ($envMap.PLANE_ADMIN_PASSWORD){ $envMap.PLANE_ADMIN_PASSWORD }elseif ($envMap.ADMIN_PASSWORD) { $envMap.ADMIN_PASSWORD } else { 'Admin123!' }
$planeWorkspace    = if ($envMap.PLANE_WORKSPACE_SLUG){ $envMap.PLANE_WORKSPACE_SLUG }else { 'turing' }
$planeWorkspaceNm  = if ($envMap.PLANE_WORKSPACE_NAME){ $envMap.PLANE_WORKSPACE_NAME }else { 'Turing' }
$planeProjectName  = if ($envMap.PLANE_PROJECT_NAME)  { $envMap.PLANE_PROJECT_NAME }  else { 'Turing OS' }
$planeProjectIdent = if ($envMap.PLANE_PROJECT_IDENTIFIER) { $envMap.PLANE_PROJECT_IDENTIFIER } else { 'TURI' }
$planeContainer    = if ($envMap.PLANE_CONTAINER)     { $envMap.PLANE_CONTAINER }     else { 'turing_plane_api' }

# Wait for plane-api
Write-Host -NoNewline "Waiting for $planeContainer"
for ($i = 0; $i -lt 60; $i++) {
    try {
        $state = docker inspect -f '{{.State.Status}}' $planeContainer 2>$null
    } catch { $state = 'missing' }

    if ($state -eq 'running') {
        try {
            docker exec $planeContainer python -c "import django; django.setup()" 2>$null | Out-Null
            Write-Host ' OK'
            break
        } catch {}
    }
    Write-Host -NoNewline '.'
    Start-Sleep -Seconds 2
}

$pyScript = @'
import os, sys, traceback

def emit(line):
    print(f"PLANE_BOOTSTRAP::{line}", flush=True)

try:
    from django.contrib.auth import get_user_model
    User = get_user_model()
    email = os.environ['PLANE_ADMIN_EMAIL']
    password = os.environ['PLANE_ADMIN_PASSWORD']

    user = User.objects.filter(email=email).first()
    if not user:
        try:
            user = User.objects.create_superuser(email=email, password=password)
        except TypeError:
            user = User(email=email, username=email, is_active=True, is_staff=True, is_superuser=True)
            user.set_password(password)
            user.save()
    else:
        user.set_password(password)
        user.is_active = True
        for attr in ('is_password_autoset', 'is_email_verified'):
            if hasattr(user, attr):
                setattr(user, attr, False if attr == 'is_password_autoset' else True)
        user.save()
    emit(f"USER_OK={user.id}")
except Exception as exc:
    emit(f"USER_ERR={exc}")
    traceback.print_exc()
    sys.exit(0)

try:
    from plane.db.models import Workspace, WorkspaceMember
    slug = os.environ['PLANE_WORKSPACE_SLUG']
    name = os.environ['PLANE_WORKSPACE_NAME']
    ws = Workspace.objects.filter(slug=slug).first()
    if not ws:
        ws = Workspace.objects.create(slug=slug, name=name, owner=user, created_by=user)
    WorkspaceMember.objects.update_or_create(
        workspace=ws, member=user,
        defaults={'role': 20, 'created_by': user},
    )
    emit(f"WS_OK={ws.id}")
    emit(f"WS_SLUG={ws.slug}")
except Exception as exc:
    emit(f"WS_ERR={exc}")
    traceback.print_exc()

try:
    from plane.db.models import Project, ProjectMember
    pname = os.environ['PLANE_PROJECT_NAME']
    pident = os.environ['PLANE_PROJECT_IDENTIFIER']
    project = Project.objects.filter(workspace=ws, name=pname).first()
    if not project:
        project = Project.objects.create(
            workspace=ws, name=pname, identifier=pident,
            created_by=user, project_lead=user,
        )
    ProjectMember.objects.update_or_create(
        project=project, member=user, workspace=ws,
        defaults={'role': 20, 'created_by': user},
    )
    emit(f"PROJECT_OK={project.id}")
except Exception as exc:
    emit(f"PROJECT_ERR={exc}")
    traceback.print_exc()

try:
    from plane.db.models import APIToken
    token_obj = APIToken.objects.filter(user=user, label='turing-bootstrap').first()
    if not token_obj:
        token_obj = APIToken.objects.create(
            user=user, label='turing-bootstrap',
            workspace=ws, created_by=user,
        )
    token_value = getattr(token_obj, 'token', None) or getattr(token_obj, 'user_token', None)
    emit(f"TOKEN_OK={token_value}")
except Exception as exc:
    emit(f"TOKEN_ERR={exc}")
    traceback.print_exc()
'@

$bootstrapOutput = $pyScript | docker exec `
    -e "PLANE_ADMIN_EMAIL=$planeAdminEmail" `
    -e "PLANE_ADMIN_PASSWORD=$planeAdminPass" `
    -e "PLANE_WORKSPACE_SLUG=$planeWorkspace" `
    -e "PLANE_WORKSPACE_NAME=$planeWorkspaceNm" `
    -e "PLANE_PROJECT_NAME=$planeProjectName" `
    -e "PLANE_PROJECT_IDENTIFIER=$planeProjectIdent" `
    -i $planeContainer python manage.py shell 2>&1

function Parse-Line {
    param([string]$Output, [string]$Key)
    $match = $Output -split "`n" | Where-Object { $_ -match "PLANE_BOOTSTRAP::${Key}=" } | Select-Object -First 1
    if ($match) {
        return ($match -replace ".*PLANE_BOOTSTRAP::${Key}=", '').Trim()
    }
    return ''
}

$userId    = Parse-Line $bootstrapOutput 'USER_OK'
$wsId      = Parse-Line $bootstrapOutput 'WS_OK'
$projectId = Parse-Line $bootstrapOutput 'PROJECT_OK'
$apiToken  = Parse-Line $bootstrapOutput 'TOKEN_OK'

if ($userId -and $wsId -and $projectId -and $apiToken) {
    Upsert-EnvValue -EnvFile $envFile -Key 'PLANE_WORKSPACE_SLUG' -Value $planeWorkspace
    Upsert-EnvValue -EnvFile $envFile -Key 'PLANE_PROJECT_ID'     -Value $projectId
    Upsert-EnvValue -EnvFile $envFile -Key 'PLANE_API_TOKEN'      -Value $apiToken
    Write-Host "OK: Plane bootstrapped (user=$userId, workspace=$wsId, project=$projectId)"
    Write-Host "    API token saved to .env (PLANE_API_TOKEN)"
} else {
    Write-Host "WARN: Plane bootstrap incomplete"
    Write-Host "  User:      $(if ($userId)    { $userId }    else { 'MISSING' })"
    Write-Host "  Workspace: $(if ($wsId)      { $wsId }      else { 'MISSING' })"
    Write-Host "  Project:   $(if ($projectId) { $projectId } else { 'MISSING' })"
    Write-Host "  Token:     $(if ($apiToken)  { 'OK' }       else { 'MISSING' })"
    Write-Host ''
    Write-Host 'Manual onboarding:'
    Write-Host '  1. Open http://localhost:9000'
    Write-Host '  2. Sign up with the admin email above and complete onboarding'
    Write-Host '  3. Generate an API token in Profile -> API Tokens'
    Write-Host '  4. Paste into PLANE_API_TOKEN in .env, then make restart'
    Write-Host ''
    Write-Host 'Bootstrap output (last 30 lines):'
    $bootstrapOutput -split "`n" | Select-Object -Last 30 | ForEach-Object { Write-Host $_ }
}
