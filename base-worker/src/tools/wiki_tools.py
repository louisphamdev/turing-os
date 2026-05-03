"""
Wiki.js Tool Interface
Functions for reading, searching, and writing documents via Wiki.js GraphQL API.
Replaces the deprecated bookstack_tools.py.
"""

import os
import json
from typing import Optional

WIKI_URL = os.environ.get('WIKI_URL', 'http://wiki:3000')
WIKI_JWT_TOKEN = os.environ.get('WIKI_JWT_TOKEN', '')


def _make_request(query: str, variables: dict = None) -> dict:
    """Internal helper for making GraphQL API requests to Wiki.js"""
    import requests

    url = f"{WIKI_URL}/graphql"
    headers = {
        'Authorization': f'Bearer {WIKI_JWT_TOKEN}',
        'Content-Type': 'application/json',
    }

    if not WIKI_JWT_TOKEN:
        print("[Wiki] WARNING: WIKI_JWT_TOKEN not configured")
        return {'error': 'Wiki.js API token not configured'}

    body: dict = {'query': query}
    if variables:
        body['variables'] = variables

    try:
        resp = requests.post(url, headers=headers, json=body, timeout=15)
        resp.raise_for_status()
        data = resp.json()

        # Check for GraphQL errors
        if 'errors' in data:
            error_msgs = [e.get('message', str(e)) for e in data['errors']]
            print(f"[Wiki] GraphQL errors: {error_msgs}")
            return {'error': '; '.join(error_msgs)}

        return data.get('data', {})
    except Exception as e:
        print(f"[Wiki] API request failed: {e}")
        return {'error': str(e)}


def read_document(page_id: str) -> dict:
    """
    Read a document from Wiki.js by page ID.
    Returns the page content including title, HTML body, and metadata.
    """
    print(f"[Wiki] Reading document: {page_id}")

    query = """
    query($id: Int!) {
      pages {
        single(id: $id) {
          id
          title
          content
          contentType
          path
          updatedAt
          tags {
            title
          }
        }
      }
    }
    """

    result = _make_request(query, {'id': int(page_id) if page_id.isdigit() else page_id})

    if 'error' in result:
        print(f"[Wiki] Failed to read document: {result['error']}")
        return {'id': page_id, 'error': result['error']}

    page = result.get('pages', {}).get('single', {})
    if not page:
        return {'id': page_id, 'error': 'Page not found'}

    return {
        'id': page.get('id', page_id),
        'title': page.get('title', ''),
        'content': page.get('content', ''),
        'contentType': page.get('contentType', 'markdown'),
        'path': page.get('path', ''),
        'updatedAt': page.get('updatedAt', ''),
        'tags': [t.get('title', '') for t in page.get('tags', [])],
    }


def search_documents(query: str) -> list:
    """
    Search for documents in Wiki.js matching the query.
    Returns a list of matching pages with their IDs and titles.
    """
    print(f"[Wiki] Searching: {query}")

    graphql_query = """
    query($query: String!) {
      pages {
        search(query: $query, limit: 10) {
          results {
            id
            title
            path
            description
          }
          total
        }
      }
    }
    """

    result = _make_request(graphql_query, {'query': query})

    if 'error' in result:
        print(f"[Wiki] Search failed: {result['error']}")
        return []

    search_data = result.get('pages', {}).get('search', {})
    results = search_data.get('results', [])
    return [
        {
            'id': item.get('id', ''),
            'title': item.get('title', ''),
            'path': item.get('path', ''),
            'description': item.get('description', '')[:200],
        }
        for item in results
    ]


def list_documents(parent_path: Optional[str] = None) -> list:
    """
    List documents in Wiki.js. Optionally filter by parent path.
    Returns a list of pages.
    """
    print(f"[Wiki] Listing documents (parent_path={parent_path})")

    if parent_path:
        query = """
        query($path: String!) {
          pages {
            list(filter: { parentPath: $path }, limit: 50) {
              id
              title
              path
            }
          }
        }
        """
        result = _make_request(query, {'path': parent_path})
    else:
        query = """
        {
          pages {
            list(limit: 50) {
              id
              title
              path
            }
          }
        }
        """
        result = _make_request(query)

    if 'error' in result:
        return []

    pages = result.get('pages', {}).get('list', [])
    return [
        {'id': item.get('id'), 'title': item.get('title'), 'path': item.get('path')}
        for item in pages
    ]


def write_document(title: str, content: str, path: str = "", is_publish: bool = True) -> dict:
    """
    Create or update a document in Wiki.js.
    Creates a new page at the specified path.

    Args:
        title: Page title
        content: Page content (markdown or HTML)
        path: Page path (e.g., "docs/my-page"). Auto-generated from title if empty.
        is_publish: Whether to publish immediately (default: True)
    """
    print(f"[Wiki] Writing document: {title}")

    if not path:
        # Auto-generate path from title
        path = title.lower().replace(' ', '-').replace('/', '-')

    query = """
    mutation($title: String!, $content: String!, $path: String!, $isPublish: Boolean!) {
      pages {
        create(title: $title, content: $content, path: $path, isPublish: $isPublish, contentType: "markdown") {
          id
          title
          path
        }
      }
    }
    """

    result = _make_request(query, {
        'title': title,
        'content': content,
        'path': path,
        'isPublish': is_publish,
    })

    if 'error' in result:
        print(f"[Wiki] Write failed: {result['error']}")
        return {'error': result['error']}

    page = result.get('pages', {}).get('create', {})
    return {
        'id': page.get('id', ''),
        'title': page.get('title', title),
        'path': page.get('path', path),
        'success': True,
    }
