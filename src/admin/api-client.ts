import type {
  AdminDirectoryListingDto,
  AdminFileContentDto,
  AdminGroupDetailResponse,
  AdminGroupListResponse,
} from "./types";

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    let details = response.statusText;
    try {
      const payload = await response.json() as { details?: string; error?: string };
      details = payload.details ?? payload.error ?? details;
    } catch {
      // Ignore JSON parsing failures on error responses.
    }
    throw new Error(details || `Request failed with ${response.status}`);
  }

  return await response.json() as T;
}

export const adminApiClient = {
  listGroups() {
    return request<AdminGroupListResponse>("/api/admin/groups");
  },

  getGroup(folder: string) {
    return request<AdminGroupDetailResponse>(`/api/admin/groups/${encodeURIComponent(folder)}`);
  },

  updateGroup(
    folder: string,
    payload: {
      name: string;
      triggerPattern: string;
      requiresTrigger: boolean;
      profileKey: string;
    },
  ) {
    return request<AdminGroupDetailResponse>(
      `/api/admin/groups/${encodeURIComponent(folder)}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    );
  },

  upsertMemory(
    folder: string,
    payload: {
      key: string;
      keyType: "builtin" | "custom";
      value: string;
    },
  ) {
    return request<AdminGroupDetailResponse>(
      `/api/admin/groups/${encodeURIComponent(folder)}/memory`,
      {
        method: "PUT",
        body: JSON.stringify(payload),
      },
    );
  },

  deleteMemory(folder: string, key: string) {
    const query = new URLSearchParams({ key });
    return request<AdminGroupDetailResponse>(
      `/api/admin/groups/${encodeURIComponent(folder)}/memory?${query.toString()}`,
      {
        method: "DELETE",
      },
    );
  },

  listFiles(folder: string, path = ".") {
    const query = new URLSearchParams({ path });
    return request<AdminDirectoryListingDto>(
      `/api/admin/groups/${encodeURIComponent(folder)}/files?${query.toString()}`,
    );
  },

  getFile(folder: string, path: string) {
    const query = new URLSearchParams({ path });
    return request<AdminFileContentDto>(
      `/api/admin/groups/${encodeURIComponent(folder)}/file?${query.toString()}`,
    );
  },

  updateFile(folder: string, path: string, content: string) {
    return request<AdminFileContentDto>(
      `/api/admin/groups/${encodeURIComponent(folder)}/file`,
      {
        method: "PUT",
        body: JSON.stringify({ path, content }),
      },
    );
  },

  createFile(folder: string, path: string, content: string, createParents = true) {
    return request<AdminFileContentDto>(
      `/api/admin/groups/${encodeURIComponent(folder)}/file`,
      {
        method: "POST",
        body: JSON.stringify({ path, content, createParents }),
      },
    );
  },

  createFolder(folder: string, path: string) {
    return request<AdminDirectoryListingDto>(
      `/api/admin/groups/${encodeURIComponent(folder)}/folder`,
      {
        method: "POST",
        body: JSON.stringify({ path }),
      },
    );
  },
};
