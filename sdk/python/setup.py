"""Setup for otk-metering Python SDK."""

from setuptools import setup, find_packages

setup(
    name="otk-metering",
    version="0.1.0",
    description="Python SDK for the OTK zk-Metering API",
    long_description=open("README.md", encoding="utf-8").read(),
    long_description_content_type="text/markdown",
    author="OTK zk-Metering",
    url="https://github.com/BrunoQuintaes/otk-zk-metering",
    packages=find_packages(),
    python_requires=">=3.9",
    install_requires=[],  # stdlib only — no external deps
    classifiers=[
        "Development Status :: 3 - Alpha",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "Topic :: Software Development :: Libraries",
    ],
    license="MIT",
)
