"""
BookStack Tool Interface

Every call routes through the orchestrator gateway proxy
(`GATEWAY_URL/gateway/bookstack/...`) using the worker's per-spawn
CONSUMER_TOKEN. Raw BookStack tokens never enter worker containers.
"""

import os
import requests
from typing import Optional


def _gateway_target(endpoint: str) -> tuple[str, dict, bool]:
    gateway_url = os.environ.get('GATEWAY_URL', '').rstrip('/')
    consumer_token = os.environ.get('CONSUMER_TOKEN', '')
    if not gateway_url or not consumer_token:
        raise RuntimeError(
            'BookStack tools require GATEWAY_URL + CONSUMER_TOKEN. '
            'Workers must be spawned with gateway mode enabled.'
        )
    url = f"{gateway_url}/gateway/bookstack/{endpoint.lstrip('/')}"
    headers = {
        'Authorization': f'Bearer {consumer_token}',
        'Accept': 'application/json',
    }
    return url, headers, True


def _make_request(method: str, endpoint: str, data: dict = None, params: dict = None) -> dict:
    """Internal helper — gateway proxy only."""
    try:
        url, headers, _ = _gateway_target(endpoint)
    except RuntimeError as exc:
        return {'error': str(exc)}

    if method.upper() not in ('GET', 'HEAD') and data is not None:
        headers['Content-Type'] = 'application/json'

    try:
        upper = method.upper()
        if upper == 'GET':
            resp = requests.get(url, headers=headers, params=params, timeout=15)
        elif upper == 'POST':
            resp = requests.post(url, headers=headers, json=data, params=params, timeout=15)
        elif upper == 'PUT':
            resp = requests.put(url, headers=headers, json=data, params=params, timeout=15)
        elif upper == 'PATCH':
            resp = requests.patch(url, headers=headers, json=data, params=params, timeout=15)
        elif upper == 'DELETE':
            resp = requests.delete(url, headers=headers, params=params, timeout=15)
        else:
            return {'error': f'Unsupported HTTP method: {method}'}

        resp.raise_for_status()
        if resp.content:
            return resp.json()
        return {'success': True}

    except requests.exceptions.HTTPError as e:
        print(f"[BookStack] HTTP error {e.response.status_code}: {e.response.text[:200]}")
        try:
            return {'error': e.response.json().get('message', str(e))}
        except (ValueError, AttributeError):
            return {'error': str(e)}
    except Exception as e:
        print(f"[BookStack] API request failed: {e}")
        return {'error': str(e)}


def read_page(page_id: str) -> dict:
    """
    Read a page from BookStack by ID.
    Returns page content including title, HTML body, and metadata.
    """
    print(f"[BookStack] Reading page: {page_id}")

    result = _make_request('GET', f'pages/{page_id}')
    if 'error' in result:
        return {'id': page_id, 'error': result['error']}

    page = result.get('page', {})
    return {
        'id': page.get('id', page_id),
        'title': page.get('name', ''),
        'html': page.get('html', ''),
        'markdown': page.get('markdown', ''),
        'slug': page.get('slug', ''),
        'updated_at': page.get('updated_at', ''),
        'created_at': page.get('created_at', ''),
    }


def get_page_by_slug(slug: str) -> dict:
    """
    Get a page by its slug (URL-friendly name).
    """
    print(f"[BookStack] Getting page by slug: {slug}")

    result = _make_request('GET', f'pages/lookup/{slug}')
    if 'error' in result:
        return {'slug': slug, 'error': result['error']}

    page = result.get('page', {})
    return {
        'id': page.get('id', ''),
        'title': page.get('name', ''),
        'slug': page.get('slug', slug),
    }


def search_pages(query: str, count: int = 10) -> list:
    """
    Search for pages in BookStack.
    Returns a list of matching pages with their IDs and titles.
    """
    print(f"[BookStack] Searching: {query}")

    result = _make_request('GET', 'search', params={'query': query, 'count': count})
    if 'error' in result:
        print(f"[BookStack] Search failed: {result['error']}")
        return []

    results_data = result.get('data', [])
    return [
        {
            'id': item.get('id', ''),
            'type': item.get('type', ''),
            'name': item.get('name', ''),
            'url': item.get('url', ''),
            'excerpt': item.get('excerpt', '')[:200],
        }
        for item in results_data
    ]


def list_books(count: int = 50) -> list:
    """
    List all books in BookStack.
    """
    print("[BookStack] Listing books")

    result = _make_request('GET', 'books', params={'count': count})
    if 'error' in result:
        return []

    books = result.get('data', [])
    return [
        {
            'id': book.get('id', ''),
            'name': book.get('name', ''),
            'slug': book.get('slug', ''),
            'description': book.get('description', ''),
        }
        for book in books
    ]


def list_chapters(book_id: str, count: int = 50) -> list:
    """
    List chapters within a book.
    """
    print(f"[BookStack] Listing chapters in book {book_id}")

    result = _make_request('GET', f'books/{book_id}/chapters', params={'count': count})
    if 'error' in result:
        return []

    chapters = result.get('data', [])
    return [
        {
            'id': ch.get('id', ''),
            'name': ch.get('name', ''),
            'slug': ch.get('slug', ''),
        }
        for ch in chapters
    ]


def list_pages(chapter_id: str, count: int = 50) -> list:
    """
    List pages within a chapter.
    """
    print(f"[BookStack] Listing pages in chapter {chapter_id}")

    result = _make_request('GET', f'chapters/{chapter_id}/pages', params={'count': count})
    if 'error' in result:
        return []

    pages = result.get('data', [])
    return [
        {
            'id': page.get('id', ''),
            'name': page.get('name', ''),
            'slug': page.get('slug', ''),
        }
        for page in pages
    ]


def create_page(
    book_id: int,
    title: str,
    content: str,
    chapter_id: Optional[int] = None,
    template: bool = False,
    markdown: bool = True,
) -> dict:
    """
    Create a new page in BookStack.

    Args:
        book_id: ID of the book to create the page in
        title: Page title
        content: Page content (markdown or HTML)
        chapter_id: Optional chapter ID to create page within
        template: Whether this is a page template
        markdown: Whether content is markdown (True) or HTML (False)
    """
    print(f"[BookStack] Creating page: {title}")

    data = {
        'book_id': book_id,
        'name': title,
        'html': '' if markdown else content,
        'markdown': content if markdown else '',
        'template': template,
    }
    if chapter_id:
        data['chapter_id'] = chapter_id

    result = _make_request('POST', 'pages', data=data)
    if 'error' in result:
        return {'title': title, 'error': result['error']}

    page = result.get('page', result)
    return {
        'id': page.get('id', ''),
        'title': page.get('name', title),
        'slug': page.get('slug', ''),
        'url': page.get('url', ''),
    }


def update_page(page_id: int, title: str = None, content: str = None, markdown: bool = True) -> dict:
    """
    Update an existing page.

    Args:
        page_id: ID of the page to update
        title: New title (optional)
        content: New content (optional)
        markdown: Whether content is markdown (True) or HTML (False)
    """
    print(f"[BookStack] Updating page {page_id}")

    data = {}
    if title is not None:
        data['name'] = title
    if content is not None:
        if markdown:
            data['markdown'] = content
            data['html'] = ''
        else:
            data['html'] = content
            data['markdown'] = ''

    result = _make_request('PUT', f'pages/{page_id}', data=data)
    if 'error' in result:
        return {'id': page_id, 'error': result['error']}

    page = result.get('page', result)
    return {
        'id': page.get('id', page_id),
        'title': page.get('name', ''),
        'updated': True,
    }


def delete_page(page_id: int) -> dict:
    """
    Delete a page by ID.
    """
    print(f"[BookStack] Deleting page {page_id}")

    result = _make_request('DELETE', f'pages/{page_id}')
    if 'error' in result:
        return {'id': page_id, 'error': result['error']}
    return {'id': page_id, 'deleted': True}


def get_book_by_name(name: str) -> Optional[dict]:
    """
    Find a book by name. Returns None if not found.
    """
    books = list_books(count=100)
    for book in books:
        if book['name'].lower() == name.lower():
            return book
    return None


def ensure_book(name: str, description: str = '') -> dict:
    """
    Ensure a book exists, creating it if it doesn't.
    Returns the book dict.
    """
    book = get_book_by_name(name)
    if book:
        return book

    print(f"[BookStack] Creating book: {name}")
    result = _make_request('POST', 'books', data={'name': name, 'description': description})
    if 'error' in result:
        return {'error': result['error']}

    book = result.get('book', result)
    return {
        'id': book.get('id', ''),
        'name': book.get('name', name),
        'slug': book.get('slug', ''),
    }
