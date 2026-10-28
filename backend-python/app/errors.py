"""Errores de la API: se traducen a {"error": "<mensaje>", ...extra} con su código HTTP."""


class ApiError(Exception):
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra
