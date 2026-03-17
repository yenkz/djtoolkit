"""Abstract base classes for import/export adapters."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from djtoolkit.models.track import Track


@dataclass
class ImportResult:
    """Result of parsing a DJ software collection file."""
    tracks: list[Track] = field(default_factory=list)
    playlists: dict[str, list[str]] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)
    stats: dict[str, int] = field(default_factory=dict)


class ImportAdapter(ABC):
    @abstractmethod
    def parse(self, file_data: bytes) -> ImportResult:
        """Parse source format bytes into Track objects."""
        ...


class ExportAdapter(ABC):
    @abstractmethod
    def export(self, tracks: list[Track]) -> bytes:
        """Serialize Track objects into source format bytes."""
        ...
